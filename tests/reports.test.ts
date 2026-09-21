import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attendances: vi.fn(),
  employees: vi.fn(),
  holidays: vi.fn(),
  offices: vi.fn(),
  employeeCount: vi.fn(),
  attendanceCount: vi.fn(),
}));
vi.mock("@/lib/db", () => {
  const db = {
    attendance: { findMany: mocks.attendances, count: mocks.attendanceCount },
    employee: { findMany: mocks.employees, count: mocks.employeeCount },
    holiday: { findMany: mocks.holidays },
    office: { findMany: mocks.offices },
    $transaction: async (query: (client: unknown) => unknown) => query(db),
  };
  return { db };
});

import {
  getAdminDashboard,
  getReport,
  reportRecords,
} from "@/modules/reports/service";

const date = (day: string) => new Date(`${day}T00:00:00Z`);
const now = new Date("2025-01-08T12:00:00Z");
const office = {
  id: "office-1",
  name: "HQ",
  timezone: "UTC",
  weekendDays: [0, 6],
};
const shift = {
  id: "shift-1",
  name: "Day",
  startTime: "09:00",
  endTime: "17:00",
  graceMinutes: 15,
  halfDayThreshold: 240,
  timezone: "UTC",
  active: true,
};
function employee(id = "employee-1", code = "E001") {
  return {
    id,
    employeeCode: code,
    userId: `user-${id}`,
    departmentId: null,
    officeId: office.id,
    joinedAt: date("2025-01-01"),
    createdAt: date("2025-01-01"),
    updatedAt: date("2025-01-01"),
    user: {
      id: `user-${id}`,
      name: "Employee",
      email: `${id}@example.test`,
      status: "ACTIVE",
    },
    office,
    department: null,
    shifts: [
      {
        shiftId: shift.id,
        startDate: date("2025-01-01"),
        endDate: null,
        shift,
      },
    ],
    leaves: [{ startDate: date("2025-01-03"), endDate: date("2025-01-03") }],
  };
}
function attendance(target = employee(), day = "2025-01-06") {
  return {
    id: `attendance-${target.id}-${day}`,
    employeeId: target.id,
    officeId: target.officeId,
    attendanceDate: date(day),
    status: "LATE",
    checkInAt: new Date(`${day}T09:30:00Z`),
    checkOutAt: new Date(`${day}T17:00:00Z`),
    lateMinutes: 30,
    lateReason: "Train service was delayed.",
    workedMinutes: 450,
    employee: target,
    office: target.office,
    shift,
    checkInLatitude: 99,
    checkInIp: "private-test-address",
  };
}
const filters = {
  from: "2025-01-01",
  to: "2025-01-07",
  format: "json" as const,
  page: 1,
  pageSize: 100,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  mocks.attendances.mockResolvedValue([attendance()]);
  mocks.employees.mockResolvedValue([employee()]);
  mocks.holidays.mockResolvedValue([
    { officeId: office.id, date: date("2025-01-02") },
  ]);
  mocks.offices.mockResolvedValue([office]);
  mocks.employeeCount.mockResolvedValue(1);
  mocks.attendanceCount.mockResolvedValue(0);
});
afterEach(() => vi.useRealTimers());

describe("dynamic report derivation", () => {
  it("preserves recorded days and derived absence, leave, holiday and weekend ordering", async () => {
    const rows = await reportRecords(filters, now);
    expect(rows.map((row) => row.status)).toEqual([
      "ABSENT",
      "LATE",
      "WEEKEND",
      "WEEKEND",
      "LEAVE",
      "HOLIDAY",
      "ABSENT",
    ]);
    expect(JSON.stringify(rows)).not.toContain("checkInLatitude");
    expect(JSON.stringify(rows)).not.toContain("private-test-address");
    expect(JSON.stringify(rows)).not.toContain('"leaves"');
  });

  it("includes submitted late reasons only in hydrated attendance details", async () => {
    const record = { ...attendance(), status: "HALF_DAY" };
    mocks.attendances.mockResolvedValue([record]);
    const rows = await reportRecords(filters, now);
    expect(rows.find((row) => row.id === record.id)).toMatchObject({
      status: "HALF_DAY",
      lateReason: "Train service was delayed.",
    });
    expect(
      rows.filter((row) => row.derived).map((row) => row.lateReason),
    ).toEqual(Array(6).fill(null));
    expect(mocks.attendances.mock.calls[0][0].select).not.toHaveProperty(
      "lateReason",
    );
    expect(mocks.attendances.mock.calls[1][0].select.lateReason).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("private-test-address");
  });

  it("does not derive an absence inside grace, before joining, or for a deactivated account today", async () => {
    mocks.attendances.mockResolvedValue([]);
    const today = { ...filters, from: "2025-01-08", to: "2025-01-08" };
    expect(
      await reportRecords(today, new Date("2025-01-08T09:10:00Z")),
    ).toHaveLength(0);
    const target = employee();
    mocks.employees.mockResolvedValue([
      { ...target, user: { ...target.user, status: "INACTIVE" } },
    ]);
    expect(await reportRecords(today, now)).toHaveLength(0);
    mocks.employees.mockResolvedValue([
      { ...target, joinedAt: date("2025-01-09") },
    ]);
    expect(await reportRecords(today, now)).toHaveLength(0);
  });

  it("preserves status-filtered totals and pages across persisted and derived records", async () => {
    const result = await getReport({
      ...filters,
      status: "ABSENT",
      page: 2,
      pageSize: 1,
    });
    expect(result).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    if (result instanceof Response) throw new Error("Expected JSON page");
    expect(result.items.map((row) => row.attendanceDate)).toEqual([
      date("2025-01-01"),
    ]);
  });

  it("hydrates only stored rows on the selected JSON page", async () => {
    const targets = [
      employee("employee-1", "E001"),
      employee("employee-2", "E002"),
    ];
    mocks.employees.mockResolvedValue(targets);
    const records = targets.map((target) => attendance(target));
    mocks.attendances
      .mockResolvedValueOnce(records)
      .mockResolvedValueOnce([records[1]]);
    const result = await getReport({
      ...filters,
      from: "2025-01-06",
      to: "2025-01-06",
      page: 2,
      pageSize: 1,
    });
    expect(result).toMatchObject({ total: 2, page: 2 });
    if (result instanceof Response) throw new Error("Expected JSON page");
    expect(result.items.map((row) => row.id)).toEqual([records[1].id]);
    expect(mocks.attendances).toHaveBeenCalledTimes(2);
    expect(mocks.attendances.mock.calls[1][0].where.id.in).toEqual([
      records[1].id,
    ]);
    expect(mocks.attendances.mock.calls[0][0].select).not.toHaveProperty(
      "checkInLatitude",
    );
  });

  it("rejects excessive ranges before accessing the database", async () => {
    await expect(
      reportRecords({ ...filters, from: "2024-01-01" }, now),
    ).rejects.toThrow("93 days");
    expect(mocks.attendances).not.toHaveBeenCalled();
  });
});

describe("late reason exports", () => {
  it("exports quoted, multiline reasons safely in CSV", async () => {
    mocks.attendances.mockResolvedValue([
      {
        ...attendance(),
        lateReason: '=Train delay, "signal issue"\nNo service.',
      },
    ]);
    const result = await getReport({ ...filters, format: "csv" });
    if (!(result instanceof Response)) throw new Error("Expected CSV export");
    const csv = await result.text();
    expect(csv.split("\r\n")[0]).toContain('"Derived","Late reason"');
    expect(csv).toContain('"\'=Train delay, ""signal issue""\nNo service."');
    expect(csv).not.toContain("private-test-address");
  });

  it("keeps formula-like reasons as text in Excel", async () => {
    vi.useRealTimers();
    const reason = '=HYPERLINK("https://example.test", "Train delay")';
    mocks.attendances.mockResolvedValue([
      { ...attendance(), lateReason: reason },
    ]);
    const result = await getReport({
      ...filters,
      from: "2025-01-06",
      to: "2025-01-06",
      format: "xlsx",
    });
    if (!(result instanceof Response)) throw new Error("Expected Excel export");
    const ExcelJS = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await result.arrayBuffer());
    const sheet = workbook.worksheets[0];
    expect(sheet.getCell("N1").value).toBe("Late reason");
    expect(sheet.getCell("N2").value).toBe(reason);
    expect(sheet.getCell("N2").type).toBe(ExcelJS.ValueType.String);
  });
});

describe("live dashboard", () => {
  it("stops employee pagination in the first batch that exceeds an office's limit", async () => {
    mocks.attendances.mockResolvedValue([]);
    const target = employee();
    const employees = Array.from({ length: 2000 }, (_, index) => ({
      ...target,
      id: `employee-${index}`,
    }));
    mocks.employees.mockImplementation(({ cursor, take }) => {
      const start = cursor
        ? Number(cursor.id.slice("employee-".length)) + 1
        : 0;
      return Promise.resolve(employees.slice(start, start + take));
    });

    await expect(getAdminDashboard(now)).rejects.toMatchObject({
      code: "REPORT_TOO_LARGE",
    });
    expect(mocks.employees).toHaveBeenCalledTimes(5);
    expect(mocks.employees.mock.lastCall?.[0].cursor).toEqual({
      id: "employee-999",
    });
  });

  it("stops attendance pagination in the first batch that exceeds an office's limit", async () => {
    mocks.employees.mockResolvedValue([]);
    const record = attendance();
    const records = Array.from({ length: 51000 }, (_, index) => ({
      ...record,
      id: `record-${index}`,
    }));
    mocks.attendances.mockImplementation(({ cursor, take }) => {
      if (take === 8) return Promise.resolve([]);
      const start = cursor ? Number(cursor.id.slice("record-".length)) + 1 : 0;
      return Promise.resolve(records.slice(start, start + take));
    });

    await expect(getAdminDashboard(now)).rejects.toMatchObject({
      code: "REPORT_TOO_LARGE",
    });
    const scans = mocks.attendances.mock.calls.filter(
      ([query]) => query.take === 500,
    );
    expect(scans).toHaveLength(101);
    expect(scans.at(-1)?.[0].cursor).toEqual({ id: "record-49999" });
  });

  it("allows more than 1,000 employees across offices below their individual limits", async () => {
    mocks.attendances.mockResolvedValue([]);
    const secondOffice = { ...office, id: "office-2" };
    mocks.offices.mockResolvedValue([office, secondOffice]);
    mocks.employeeCount.mockResolvedValue(1200);
    const target = employee();
    const employees = Array.from({ length: 1200 }, (_, index) => ({
      ...target,
      id: `employee-${index}`,
      officeId: index < 600 ? office.id : secondOffice.id,
      office: index < 600 ? office : secondOffice,
      shifts: [],
    }));
    mocks.employees.mockImplementation(({ cursor, take }) => {
      const start = cursor
        ? Number(cursor.id.slice("employee-".length)) + 1
        : 0;
      return Promise.resolve(employees.slice(start, start + take));
    });

    await expect(getAdminDashboard(now)).resolves.toMatchObject({
      totalEmployees: 1200,
      absentToday: 0,
    });
    expect(mocks.employees).toHaveBeenCalledTimes(5);
  });

  it("batches offices and counts an overnight shift on its previous calendar date", async () => {
    const secondOffice = { ...office, id: "office-2", timezone: "Asia/Dhaka" };
    const night = { ...shift, startTime: "20:00", endTime: "05:00" };
    const first = employee();
    const second = {
      ...employee("employee-2", "E002"),
      officeId: secondOffice.id,
      office: secondOffice,
    };
    mocks.offices.mockResolvedValue([office, secondOffice]);
    mocks.employees.mockResolvedValue([first, second]);
    mocks.employeeCount.mockResolvedValue(2);
    const record = {
      ...attendance(first),
      shift: night,
      checkInAt: new Date("2025-01-06T20:30:00Z"),
      checkOutAt: null,
    };
    mocks.attendances.mockResolvedValue([record]);
    mocks.attendanceCount.mockResolvedValue(1);
    const result = await getAdminDashboard(new Date("2025-01-07T03:00:00Z"));
    expect(result).toMatchObject({
      totalEmployees: 2,
      presentToday: 1,
      lateToday: 1,
      checkedOut: 0,
      currentlyCheckedIn: 1,
    });
    expect(mocks.holidays).toHaveBeenCalledTimes(1);
    expect(mocks.employees).toHaveBeenCalledTimes(1);
    expect(mocks.attendances).toHaveBeenCalledTimes(2);
  });

  it("reads attendance again on the next dashboard request", async () => {
    mocks.attendances.mockResolvedValue([]);
    const first = await getAdminDashboard(now);
    mocks.attendances.mockResolvedValue([attendance(employee(), "2025-01-08")]);
    const second = await getAdminDashboard(now);
    expect(first.presentToday).toBe(0);
    expect(second.presentToday).toBe(1);
  });
});
