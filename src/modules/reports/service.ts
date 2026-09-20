import { Prisma, type AttendanceStatus } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { employeeInclude } from "@/modules/employees/service";
import { reportFilterSchema, utcDate } from "@/modules/management/validation";
import {
  addCalendarDays,
  getShiftWindow,
  shiftDate,
} from "@/modules/shifts/calculations";
import { toCsv } from "./export";

type Filters = z.infer<typeof reportFilterSchema>;
const attendanceInclude = {
  employee: { include: employeeInclude },
  office: true,
  shift: true,
} satisfies Prisma.AttendanceInclude;
export type ReportRecord = Pick<
  Prisma.AttendanceGetPayload<{ include: typeof attendanceInclude }>,
  | "employee"
  | "office"
  | "shift"
  | "attendanceDate"
  | "status"
  | "checkInAt"
  | "checkOutAt"
  | "lateMinutes"
  | "workedMinutes"
> & { id: string; derived: boolean };

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
    createdAt: employee.createdAt,
    updatedAt: employee.updatedAt,
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

export async function reportRecords(
  filters: Filters,
  now = new Date(),
): Promise<ReportRecord[]> {
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
  const [records, employees, holidays] = await Promise.all([
    db.attendance.findMany({
      where: {
        attendanceDate: dateRange,
        ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
        ...(filters.departmentId
          ? { employee: { departmentId: filters.departmentId } }
          : {}),
        ...(filters.officeId ? { officeId: filters.officeId } : {}),
        ...(filters.shiftId ? { shiftId: filters.shiftId } : {}),
      },
      include: attendanceInclude,
      orderBy: [{ attendanceDate: "desc" }, { employeeId: "asc" }],
      take: 50001,
    }),
    db.employee.findMany({
      where: {
        ...(filters.employeeId ? { id: filters.employeeId } : {}),
        ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
        ...(filters.officeId ? { officeId: filters.officeId } : {}),
      },
      include: {
        ...employeeInclude,
        shifts: {
          where: {
            startDate: { lte: dateRange.lte },
            OR: [{ endDate: null }, { endDate: { gte: dateRange.gte } }],
          },
          include: { shift: true },
        },
        leaves: {
          where: {
            status: "APPROVED",
            startDate: { lte: dateRange.lte },
            endDate: { gte: dateRange.gte },
          },
        },
      },
      take: 1001,
    }),
    db.holiday.findMany({ where: { date: dateRange } }),
  ]);
  if (employees.length > 1000 || records.length > 50000)
    throw new DomainError(
      "REPORT_TOO_LARGE",
      "Narrow the report using an employee, department, office, or date filter.",
    );
  const rows: ReportRecord[] = records.map((record) =>
    sanitizedRecord(record, false),
  );
  const recorded = new Set(
    records.map(
      (record) =>
        `${record.employeeId}:${record.attendanceDate.toISOString().slice(0, 10)}`,
    ),
  );
  for (const employee of employees) {
    for (let day = from; day <= to; day = addCalendarDays(day, 1)) {
      const attendanceDate = utcDate(day);
      if (
        recorded.has(`${employee.id}:${day}`) ||
        day < shiftDate(employee.joinedAt, employee.office.timezone)
      )
        continue;
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
      const window = getShiftWindow(now, assignment.shift, day);
      // An unstarted shift is not an absence. Historic scheduled days remain reportable even if the shift is later disabled.
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
        holidays.some(
          (holiday) =>
            holiday.date.valueOf() === attendanceDate.valueOf() &&
            (!holiday.officeId || holiday.officeId === employee.officeId),
        )
      )
        status = "HOLIDAY";
      else if (employee.office.weekendDays.includes(attendanceDate.getUTCDay()))
        status = "WEEKEND";
      // Until grace has elapsed, a scheduled employee can still arrive on time.
      if (
        status === "ABSENT" &&
        window.startsAt.valueOf() + assignment.shift.graceMinutes * 60000 >=
          now.valueOf()
      )
        continue;
      // Keep historical rows after deactivation, but do not generate today's absence for an inactive account.
      if (
        employee.user.status !== "ACTIVE" &&
        day >= shiftDate(now, assignment.shift.timezone)
      )
        continue;
      rows.push(
        sanitizedRecord(
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
      );
      if (rows.length > 50000)
        throw new DomainError(
          "REPORT_TOO_LARGE",
          "Narrow the report using an employee, department, office, or date filter.",
        );
    }
  }
  return rows
    .filter((row) => !filters.status || row.status === filters.status)
    .sort(
      (a, b) =>
        b.attendanceDate.valueOf() - a.attendanceDate.valueOf() ||
        a.employee.employeeCode.localeCompare(b.employee.employeeCode),
    );
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
  const records = await reportRecords(filters);
  if (filters.format === "json") {
    return {
      items: records.slice(
        (filters.page - 1) * filters.pageSize,
        filters.page * filters.pageSize,
      ),
      total: records.length,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }
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

export async function getAdminDashboard(now = new Date()) {
  const offices = await db.office.findMany({
    where: { active: true },
    select: { id: true, timezone: true },
  });
  const officeRecords = await Promise.all(
    offices.map((office) => {
      const day = shiftDate(now, office.timezone);
      const records = reportRecords(
        {
          officeId: office.id,
          from: addCalendarDays(day, -1),
          to: addCalendarDays(day, 1),
          format: "json",
          page: 1,
          pageSize: 100,
        },
        now,
      );
      return records.then((rows) =>
        rows.filter(
          (row) =>
            row.attendanceDate.valueOf() ===
            getShiftWindow(now, row.shift).attendanceDate.valueOf(),
        ),
      );
    }),
  );
  const today = officeRecords.flat();
  const [totalEmployees, currentlyCheckedIn, recentAttendance] =
    await Promise.all([
      db.employee.count({ where: { user: { status: "ACTIVE" } } }),
      db.attendance.count({
        where: { checkInAt: { not: null }, checkOutAt: null },
      }),
      db.attendance.findMany({
        include: attendanceInclude,
        orderBy: { updatedAt: "desc" },
        take: 8,
      }),
    ]);
  return {
    totalEmployees,
    presentToday: today.filter((row) => row.checkInAt !== null).length,
    lateToday: today.filter((row) => row.lateMinutes > 0).length,
    absentToday: today.filter((row) => row.status === "ABSENT").length,
    currentlyCheckedIn,
    checkedOut: today.filter((row) => row.checkOutAt !== null).length,
    recentAttendance: recentAttendance.map((record) =>
      sanitizedRecord(record, false),
    ),
  };
}
