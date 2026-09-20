import { Prisma, type AttendanceStatus } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { reportFilterSchema, utcDate } from "@/modules/management/validation";
import {
  addCalendarDays,
  getShiftWindow,
  shiftDate,
} from "@/modules/shifts/calculations";
import { toCsv } from "./export";

type Filters = z.infer<typeof reportFilterSchema>;
const officeSelect = {
  id: true,
  name: true,
  timezone: true,
  weekendDays: true,
} satisfies Prisma.OfficeSelect;
const shiftSelect = {
  id: true,
  name: true,
  startTime: true,
  endTime: true,
  graceMinutes: true,
  halfDayThreshold: true,
  timezone: true,
  active: true,
} satisfies Prisma.ShiftSelect;
const employeeSelect = {
  id: true,
  employeeCode: true,
  userId: true,
  departmentId: true,
  officeId: true,
  joinedAt: true,
  user: { select: { id: true, name: true, email: true, status: true } },
  office: { select: officeSelect },
  department: { select: { id: true, name: true } },
} satisfies Prisma.EmployeeSelect;
const attendanceSelect = {
  id: true,
  attendanceDate: true,
  status: true,
  checkInAt: true,
  checkOutAt: true,
  lateMinutes: true,
  workedMinutes: true,
  employee: { select: employeeSelect },
  office: { select: officeSelect },
  shift: { select: shiftSelect },
} satisfies Prisma.AttendanceSelect;
// Sorting, derivation and live counts do not require detailed employee/office data.
const candidateSelect = {
  id: true,
  employeeId: true,
  officeId: true,
  attendanceDate: true,
  status: true,
  checkInAt: true,
  checkOutAt: true,
  lateMinutes: true,
  workedMinutes: true,
  employee: { select: { employeeCode: true } },
  shift: { select: shiftSelect },
} satisfies Prisma.AttendanceSelect;
type Candidate = Prisma.AttendanceGetPayload<{
  select: typeof candidateSelect;
}>;
export type ReportRecord = Prisma.AttendanceGetPayload<{
  select: typeof attendanceSelect;
}> & { derived: boolean };
type Entry =
  | { derived: false; record: Candidate }
  | { derived: true; record: ReportRecord };
type OfficeScope = { id: string; from: string; to: string };

function sanitizedEmployee(
  employee: ReportRecord["employee"],
): ReportRecord["employee"] {
  return {
    id: employee.id,
    employeeCode: employee.employeeCode,
    userId: employee.userId,
    departmentId: employee.departmentId,
    officeId: employee.officeId,
    joinedAt: employee.joinedAt,
    user: employee.user,
    office: employee.office,
    department: employee.department,
  };
}
function sanitizedRecord(
  record: Omit<ReportRecord, "derived">,
  derived: boolean,
): ReportRecord {
  return {
    id: record.id,
    employee: sanitizedEmployee(record.employee),
    office: record.office,
    shift: record.shift,
    attendanceDate: record.attendanceDate,
    status: record.status,
    checkInAt: record.checkInAt,
    checkOutAt: record.checkOutAt,
    lateMinutes: record.lateMinutes,
    workedMinutes: record.workedMinutes,
    derived,
  };
}
function tooLarge(): never {
  throw new DomainError(
    "REPORT_TOO_LARGE",
    "Narrow the report using an employee, department, office, or date filter.",
  );
}

/** All inputs and derived state are local to this invocation, never cached. */
async function reportEntries(
  filters: Filters,
  now = new Date(),
  scopes?: OfficeScope[],
): Promise<Entry[]> {
  const to = filters.to ?? now.toISOString().slice(0, 10);
  const from = filters.from ?? addCalendarDays(to, -29);
  if (
    to < from ||
    (utcDate(to).valueOf() - utcDate(from).valueOf()) / 86400000 > 92
  )
    throw new DomainError(
      "REPORT_RANGE_TOO_LARGE",
      "Choose a date range of 93 days or fewer.",
    );
  const dateRange = { gte: utcDate(from), lte: utcDate(to) };
  const attendanceWhere: Prisma.AttendanceWhereInput = {
    attendanceDate: dateRange,
    ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
    ...(filters.departmentId
      ? { employee: { departmentId: filters.departmentId } }
      : {}),
    ...(filters.officeId ? { officeId: filters.officeId } : {}),
    ...(filters.shiftId ? { shiftId: filters.shiftId } : {}),
    ...(scopes
      ? {
          OR: scopes.map((scope) => ({
            officeId: scope.id,
            attendanceDate: {
              gte: utcDate(scope.from),
              lte: utcDate(scope.to),
            },
          })),
        }
      : {}),
  };
  const employeeWhere: Prisma.EmployeeWhereInput = {
    ...(filters.employeeId ? { id: filters.employeeId } : {}),
    ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
    ...(filters.officeId ? { officeId: filters.officeId } : {}),
    ...(scopes ? { officeId: { in: scopes.map((scope) => scope.id) } } : {}),
  };
  const scheduleSelect = {
    ...employeeSelect,
    shifts: {
      where: {
        startDate: { lte: dateRange.lte },
        OR: [{ endDate: null }, { endDate: { gte: dateRange.gte } }],
      },
      select: {
        shiftId: true,
        startDate: true,
        endDate: true,
        shift: { select: shiftSelect },
      },
      orderBy: [{ startDate: "desc" }, { id: "asc" }],
    },
    leaves: {
      where: {
        status: "APPROVED",
        startDate: { lte: dateRange.lte },
        endDate: { gte: dateRange.gte },
      },
      select: { startDate: true, endDate: true },
    },
  } satisfies Prisma.EmployeeSelect;
  const rowCounts = new Map<string, number>();
  function countRow(officeId: string) {
    const count = (rowCounts.get(officeId) ?? 0) + 1;
    rowCounts.set(officeId, count);
    if (scopes && count > 50000) tooLarge();
  }
  // Bounded cursor batches preserve the old per-office limits without adding a
  // new organization-wide 1,000 employee limit to the dashboard.
  async function candidates() {
    if (!scopes)
      return db.attendance.findMany({
        where: attendanceWhere,
        select: candidateSelect,
        take: 50001,
      });
    const result: Candidate[] = [];
    let cursor: string | undefined;
    while (true) {
      const batch: Candidate[] = await db.attendance.findMany({
        where: attendanceWhere,
        select: candidateSelect,
        orderBy: { id: "asc" },
        take: 500,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const record of batch) countRow(record.officeId);
      result.push(...batch);
      if (batch.length < 500) return result;
      cursor = batch[batch.length - 1].id;
    }
  }
  async function scheduledEmployees() {
    if (!scopes)
      return db.employee.findMany({
        where: employeeWhere,
        select: scheduleSelect,
        take: 1001,
      });
    type Scheduled = Prisma.EmployeeGetPayload<{
      select: typeof scheduleSelect;
    }>;
    const result: Scheduled[] = [];
    const employeeCounts = new Map<string, number>();
    let cursor: string | undefined;
    while (true) {
      const batch: Scheduled[] = await db.employee.findMany({
        where: employeeWhere,
        select: scheduleSelect,
        orderBy: { id: "asc" },
        take: 250,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const employee of batch) {
        const count = (employeeCounts.get(employee.officeId) ?? 0) + 1;
        employeeCounts.set(employee.officeId, count);
        if (count > 1000) tooLarge();
      }
      result.push(...batch);
      if (batch.length < 250) return result;
      cursor = batch[batch.length - 1].id;
    }
  }
  const [records, employees, holidays] = await Promise.all([
    candidates(),
    scheduledEmployees(),
    db.holiday.findMany({
      where: {
        date: dateRange,
        ...(scopes
          ? {
              OR: [
                { officeId: null },
                { officeId: { in: scopes.map((scope) => scope.id) } },
              ],
            }
          : {}),
      },
      select: { date: true, officeId: true },
    }),
  ]);
  if (!scopes && (employees.length > 1000 || records.length > 50000))
    tooLarge();
  const scoped = new Map(scopes?.map((scope) => [scope.id, scope]));
  const key = (employeeId: string, day: string, officeId: string) =>
    `${scopes ? officeId + ":" : ""}${employeeId}:${day}`;
  const recorded = new Set(
    records.map((record) =>
      key(
        record.employeeId,
        record.attendanceDate.toISOString().slice(0, 10),
        record.officeId,
      ),
    ),
  );
  const rows: Entry[] = records.map((record) => ({
    derived: false,
    record,
  }));
  const holidayDays = new Set(
    holidays.map(
      (holiday) => `${holiday.date.valueOf()}:${holiday.officeId ?? "*"}`,
    ),
  );
  // Reuse pure date calculations inside this request, never validation evidence.
  const windows = new Map<string, ReturnType<typeof getShiftWindow>>();
  const currentDates = new Map<string, string>();
  for (const employee of employees) {
    const scope = scoped.get(employee.officeId);
    const firstDay = scope?.from ?? from,
      lastDay = scope?.to ?? to;
    const joined = shiftDate(employee.joinedAt, employee.office.timezone);
    for (let day = firstDay; day <= lastDay; day = addCalendarDays(day, 1)) {
      if (
        day < joined ||
        recorded.has(key(employee.id, day, employee.officeId))
      )
        continue;
      const attendanceDate = utcDate(day);
      const assignment = employee.shifts.find(
        (item) =>
          item.startDate <= attendanceDate &&
          (!item.endDate || item.endDate >= attendanceDate),
      );
      if (
        !assignment ||
        (filters.shiftId && assignment.shiftId !== filters.shiftId)
      )
        continue;
      const windowKey = `${assignment.shiftId}:${day}`;
      let window = windows.get(windowKey);
      if (!window) {
        window = getShiftWindow(now, assignment.shift, day);
        windows.set(windowKey, window);
      }
      if (window.startsAt > now) continue;
      let status: AttendanceStatus = "ABSENT";
      if (
        employee.leaves.some(
          (leave) =>
            leave.startDate <= attendanceDate &&
            leave.endDate >= attendanceDate,
        )
      )
        status = "LEAVE";
      else if (
        holidayDays.has(`${attendanceDate.valueOf()}:*`) ||
        holidayDays.has(`${attendanceDate.valueOf()}:${employee.officeId}`)
      )
        status = "HOLIDAY";
      else if (employee.office.weekendDays.includes(attendanceDate.getUTCDay()))
        status = "WEEKEND";
      if (
        status === "ABSENT" &&
        window.startsAt.valueOf() + assignment.shift.graceMinutes * 60000 >=
          now.valueOf()
      )
        continue;
      if (employee.user.status !== "ACTIVE") {
        let current = currentDates.get(assignment.shift.timezone);
        if (!current) {
          current = shiftDate(now, assignment.shift.timezone);
          currentDates.set(assignment.shift.timezone, current);
        }
        if (day >= current) continue;
      }
      rows.push({
        derived: true,
        record: sanitizedRecord(
          {
            id: `scheduled:${employee.id}:${day}`,
            employee,
            office: employee.office,
            shift: assignment.shift,
            attendanceDate,
            status,
            checkInAt: null,
            checkOutAt: null,
            lateMinutes: 0,
            workedMinutes: 0,
          },
          true,
        ),
      });
      countRow(employee.officeId);
      if (!scopes && rows.length > 50000) tooLarge();
    }
  }
  return rows
    .filter(
      (entry) => !filters.status || entry.record.status === filters.status,
    )
    .sort(
      (a, b) =>
        b.record.attendanceDate.valueOf() - a.record.attendanceDate.valueOf() ||
        a.record.employee.employeeCode.localeCompare(
          b.record.employee.employeeCode,
        ) ||
        a.record.id.localeCompare(b.record.id),
    );
}

async function hydrateEntries(entries: Entry[]): Promise<ReportRecord[]> {
  const ids = entries
    .filter((entry) => !entry.derived)
    .map((entry) => entry.record.id);
  const records = ids.length
    ? await db.attendance.findMany({
        where: { id: { in: ids } },
        select: attendanceSelect,
      })
    : [];
  const byId = new Map(records.map((record) => [record.id, record]));
  return entries.map((entry) => {
    if (entry.derived) return entry.record;
    const detail = byId.get(entry.record.id);
    if (!detail)
      throw new DomainError(
        "REPORT_CHANGED",
        "Attendance changed while loading. Refresh the report.",
        409,
      );
    // Retain the scanned attendance values so a concurrent correction between
    // scanning and page hydration cannot disagree with the page's totals/order.
    const {
      id,
      attendanceDate,
      status,
      checkInAt,
      checkOutAt,
      lateMinutes,
      workedMinutes,
      shift,
    } = entry.record;
    return sanitizedRecord(
      {
        ...detail,
        id,
        attendanceDate,
        status,
        checkInAt,
        checkOutAt,
        lateMinutes,
        workedMinutes,
        shift,
      },
      false,
    );
  });
}
export async function reportRecords(
  filters: Filters,
  now = new Date(),
): Promise<ReportRecord[]> {
  return hydrateEntries(await reportEntries(filters, now));
}

export async function getAdminDashboard(now = new Date()) {
  const summary = Promise.all([
    db.employee.count({ where: { user: { status: "ACTIVE" } } }),
    db.attendance.count({
      where: { checkInAt: { not: null }, checkOutAt: null },
    }),
    db.attendance.findMany({
      select: attendanceSelect,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 8,
    }),
  ]);
  const todayPromise = (async () => {
    const offices = await db.office.findMany({
      where: { active: true },
      select: { id: true, timezone: true },
    });
    if (!offices.length) return [];
    const scopes = offices.map((office) => {
      const day = shiftDate(now, office.timezone);
      return {
        id: office.id,
        from: addCalendarDays(day, -1),
        to: addCalendarDays(day, 1),
      };
    });
    const from = scopes.reduce(
      (value, scope) => (scope.from < value ? scope.from : value),
      scopes[0].from,
    );
    const to = scopes.reduce(
      (value, scope) => (scope.to > value ? scope.to : value),
      scopes[0].to,
    );
    const rows = await reportEntries(
      { from, to, format: "json", page: 1, pageSize: 100 },
      now,
      scopes,
    );
    const shiftDays = new Map<string, number>();
    return rows.filter(({ record }) => {
      let day = shiftDays.get(record.shift.id);
      if (day === undefined) {
        day = getShiftWindow(now, record.shift).attendanceDate.valueOf();
        shiftDays.set(record.shift.id, day);
      }
      return record.attendanceDate.valueOf() === day;
    });
  })();
  const [[totalEmployees, currentlyCheckedIn, recentAttendance], today] =
    await Promise.all([summary, todayPromise]);
  const totals = {
    presentToday: 0,
    lateToday: 0,
    absentToday: 0,
    checkedOut: 0,
  };
  for (const { record } of today) {
    if (record.checkInAt !== null) totals.presentToday++;
    if (record.lateMinutes > 0) totals.lateToday++;
    if (record.status === "ABSENT") totals.absentToday++;
    if (record.checkOutAt !== null) totals.checkedOut++;
  }
  return {
    totalEmployees,
    ...totals,
    currentlyCheckedIn,
    recentAttendance: recentAttendance.map((record) =>
      sanitizedRecord(record, false),
    ),
  };
}

const columns = [
  "Date",
  "Employee ID",
  "Employee",
  "Email",
  "Department",
  "Office",
  "Shift",
  "Status",
  "Check-in (UTC)",
  "Check-out (UTC)",
  "Late minutes",
  "Worked minutes",
  "Derived",
];
function exportRows(records: ReportRecord[]) {
  return records.map((row) => [
    row.attendanceDate.toISOString().slice(0, 10),
    row.employee.employeeCode,
    row.employee.user.name ?? "",
    row.employee.user.email,
    row.employee.department?.name ?? "",
    row.office.name,
    row.shift.name,
    row.status,
    row.checkInAt?.toISOString() ?? "",
    row.checkOutAt?.toISOString() ?? "",
    row.lateMinutes,
    row.workedMinutes,
    row.derived ? "Yes" : "No",
  ]);
}

export async function getReport(filters: Filters) {
  const entries = await reportEntries(filters);
  if (filters.format === "json") {
    return {
      items: await hydrateEntries(
        entries.slice(
          (filters.page - 1) * filters.pageSize,
          filters.page * filters.pageSize,
        ),
      ),
      total: entries.length,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }
  const records = await hydrateEntries(entries);
  const filename = `attendance-${new Date().toISOString().slice(0, 10)}`;
  if (filters.format === "csv")
    return new Response(toCsv(columns, exportRows(records)), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}.csv"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Attendance", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.addRow(columns);
  for (const row of exportRows(records)) sheet.addRow(row);
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF163C36" },
  };
  sheet.columns.forEach((column, index) => {
    column.width = index === 3 ? 32 : index === 8 || index === 9 ? 26 : 20;
  });
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(records.length + 1, 1), column: columns.length },
  };
  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}.xlsx"`,
    },
  });
}
