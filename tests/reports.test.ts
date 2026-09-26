import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attendances: vi.fn(),
  employees: vi.fn(),
  holidays: vi.fn(),
  offices: vi.fn(),
  employeeCount: vi.fn(),
  attendanceCount: vi.fn(),
  pdf: vi.fn(),
}));
vi.mock("@/modules/reports/pdf", () => ({ createReportPdf: mocks.pdf }));
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

const admin = { id: "admin", role: "ADMIN" } as const;
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
    overtimeMinutes: 0,
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
  mocks.pdf.mockResolvedValue(new TextEncoder().encode("%PDF-1.7\nfixture"));
});
afterEach(() => vi.useRealTimers());

describe("dynamic report derivation", () => {
  it("preserves recorded days and derived absence, leave, holiday and weekend ordering", async () => {
    const rows = await reportRecords(admin, filters, now);
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
    const rows = await reportRecords(admin, filters, now);
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

  it("preserves stored overtime and gives derived days zero overtime", async () => {
    const record = {
      ...attendance(),
      checkOutAt: new Date("2025-01-06T18:30:00Z"),
      workedMinutes: 540,
      overtimeMinutes: 90,
    };
    mocks.attendances.mockResolvedValue([record]);
    const rows = await reportRecords(admin, filters, now);
    expect(rows.find((row) => row.id === record.id)).toMatchObject({
      workedMinutes: 540,
      overtimeMinutes: 90,
    });
    expect(
      rows.filter((row) => row.derived).map((row) => row.overtimeMinutes),
    ).toEqual(Array(6).fill(0));
    expect(mocks.attendances.mock.calls[0][0].select.overtimeMinutes).toBe(
      true,
    );
    expect(mocks.attendances.mock.calls[1][0].select.overtimeMinutes).toBe(
      true,
    );
  });

  it("keeps overtime consistent with punches when a correction occurs during hydration", async () => {
    const scanned = {
      ...attendance(),
      checkOutAt: new Date("2025-01-06T18:30:00Z"),
      workedMinutes: 540,
      overtimeMinutes: 90,
    };
    mocks.attendances
      .mockResolvedValueOnce([scanned])
      .mockResolvedValueOnce([attendance()]);
    const rows = await reportRecords(admin, filters, now);
    expect(rows.find((row) => row.id === scanned.id)).toMatchObject({
      checkOutAt: scanned.checkOutAt,
      workedMinutes: 540,
      overtimeMinutes: 90,
    });
  });

  it("preserves unknown overtime for historical attendance", async () => {
    const record = { ...attendance(), overtimeMinutes: null };
    mocks.attendances.mockResolvedValue([record]);
    const rows = await reportRecords(admin, filters, now);
    expect(
      rows.find((row) => row.id === record.id)?.overtimeMinutes,
    ).toBeNull();
  });

  it("recalculates historical overtime from captured schedule and actual late minutes", async () => {
    const record = {
      ...attendance(),
      scheduledEndAt: new Date("2025-01-06T17:00:00Z"),
      checkOutAt: new Date("2025-01-06T17:30:00Z"),
      overtimeMinutes: 30,
    };
    mocks.attendances.mockResolvedValue([record]);
    const result = await getReport(admin, {
      ...filters,
      from: "2025-01-06",
      to: "2025-01-06",
    });
    expect(result).toMatchObject({
      summary: { overtimeMinutes: 0, unknownOvertimeRecords: 0 },
      items: [
        {
          actualLateMinutes: 30,
          effectiveLateMinutes: 30,
          rawOvertimeMinutes: 30,
          overtimeMinutes: 0,
        },
      ],
    });
  });

  it.each(["PENDING", "APPROVED", "REJECTED"] as const)(
    "uses %s late approval consistently in report status and filters",
    async (status) => {
      const record = attendance();
      mocks.attendances.mockResolvedValue([
        {
          ...record,
          lateApproval: {
            status,
            checkInAt: record.checkInAt,
            lateMinutes: 30,
          },
        },
      ]);
      const rows = await reportRecords(admin, {
        ...filters,
        from: "2025-01-06",
        to: "2025-01-06",
        status: status === "APPROVED" ? "PRESENT" : "LATE",
      });
      expect(rows).toMatchObject([
        {
          status: status === "APPROVED" ? "PRESENT" : "LATE",
          actualStatus: "LATE",
          actualLateMinutes: 30,
          effectiveLateMinutes: status === "APPROVED" ? 0 : 30,
          lateApprovalStatus: status,
        },
      ]);
      expect(JSON.stringify(rows)).not.toContain('"lateApproval":');
      if (status === "APPROVED") {
        const lateRows = await reportRecords(admin, {
          ...filters,
          from: "2025-01-06",
          to: "2025-01-06",
          status: "LATE",
        });
        expect(lateRows).toHaveLength(0);
      }
    },
  );

  it("retains the scanned approval and schedule when review completes during hydration", async () => {
    const record = attendance();
    const scanned = {
      ...record,
      checkOutAt: new Date("2025-01-06T18:00:00Z"),
      scheduledEndAt: new Date("2025-01-06T17:00:00Z"),
      lateApproval: {
        status: "PENDING",
        checkInAt: record.checkInAt,
        lateMinutes: 30,
      },
    };
    mocks.attendances.mockResolvedValueOnce([scanned]).mockResolvedValueOnce([
      {
        ...scanned,
        scheduledEndAt: new Date("2025-01-06T18:00:00Z"),
        lateApproval: { ...scanned.lateApproval, status: "APPROVED" },
      },
    ]);
    const result = await getReport(admin, {
      ...filters,
      from: "2025-01-06",
      to: "2025-01-06",
      status: "LATE",
    });
    expect(result).toMatchObject({
      total: 1,
      summary: { overtimeMinutes: 30, unknownOvertimeRecords: 0 },
      items: [
        { status: "LATE", lateApprovalStatus: "PENDING", overtimeMinutes: 30 },
      ],
    });
  });

  it("does not derive an absence inside grace, before joining, or for a deactivated account today", async () => {
    mocks.attendances.mockResolvedValue([]);
    const today = { ...filters, from: "2025-01-08", to: "2025-01-08" };
    expect(
      await reportRecords(admin, today, new Date("2025-01-08T09:10:00Z")),
    ).toHaveLength(0);
    const target = employee();
    mocks.employees.mockResolvedValue([
      { ...target, user: { ...target.user, status: "INACTIVE" } },
    ]);
    expect(await reportRecords(admin, today, now)).toHaveLength(0);
    mocks.employees.mockResolvedValue([
      { ...target, joinedAt: date("2025-01-09") },
    ]);
    expect(await reportRecords(admin, today, now)).toHaveLength(0);
  });

  it("preserves status-filtered totals and pages across persisted and derived records", async () => {
    const result = await getReport(admin, {
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
    const result = await getReport(admin, {
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
      reportRecords(admin, { ...filters, from: "2024-01-01" }, now),
    ).rejects.toThrow("93 days");
    expect(mocks.attendances).not.toHaveBeenCalled();
  });
});

describe("filtered overtime totals", () => {
  it.each([1, 2])(
    "sums exact minutes across every matching page when viewing page %i",
    async (page) => {
      const records = [
        { ...attendance(employee(), "2025-01-07"), overtimeMinutes: 45 },
        { ...attendance(employee(), "2025-01-06"), overtimeMinutes: 35 },
      ];
      mocks.attendances
        .mockResolvedValueOnce(records)
        .mockResolvedValueOnce([records[page - 1]]);

      const result = await getReport(admin, {
        ...filters,
        employeeId: "employee-1",
        from: "2025-01-06",
        to: "2025-01-07",
        page,
        pageSize: 1,
      });

      expect(result).toMatchObject({
        total: 2,
        page,
        pageSize: 1,
        summary: { overtimeMinutes: 80, unknownOvertimeRecords: 0 },
      });
      if (result instanceof Response) throw new Error("Expected JSON page");
      expect(result.items.map((row) => row.id)).toEqual([records[page - 1].id]);
      expect(mocks.attendances.mock.calls[1][0].where.id.in).toEqual([
        records[page - 1].id,
      ]);
    },
  );

  it("scopes the total to the selected employee and inclusive date range", async () => {
    const target = employee("employee-2", "E002");
    mocks.employees.mockResolvedValue([target]);
    mocks.attendances.mockResolvedValue([
      { ...attendance(target), overtimeMinutes: 47 },
    ]);

    const result = await getReport(admin, {
      ...filters,
      employeeId: target.id,
      from: "2025-01-06",
      to: "2025-01-06",
    });

    expect(result).toMatchObject({
      total: 1,
      summary: { overtimeMinutes: 47, unknownOvertimeRecords: 0 },
    });
    expect(mocks.attendances.mock.calls[0][0].where).toMatchObject({
      employeeId: target.id,
      attendanceDate: {
        gte: date("2025-01-06"),
        lte: date("2025-01-06"),
      },
    });
    expect(mocks.employees.mock.calls[0][0].where).toMatchObject({
      id: target.id,
    });
  });

  it("excludes overtime and unknown values from rows outside the status filter", async () => {
    const matching = { ...attendance(), overtimeMinutes: 45 };
    mocks.attendances
      .mockResolvedValueOnce([
        matching,
        {
          ...attendance(employee(), "2025-01-07"),
          status: "PRESENT",
          overtimeMinutes: 120,
        },
        {
          ...attendance(employee(), "2025-01-05"),
          status: "HALF_DAY",
          overtimeMinutes: null,
        },
      ])
      .mockResolvedValueOnce([matching]);

    const result = await getReport(admin, { ...filters, status: "LATE" });

    expect(result).toMatchObject({
      total: 1,
      summary: { overtimeMinutes: 45, unknownOvertimeRecords: 0 },
    });
  });

  it("counts unknown overtime across pages without treating derived days as unknown", async () => {
    const known = { ...attendance(), overtimeMinutes: 35 };
    mocks.attendances
      .mockResolvedValueOnce([
        known,
        {
          ...attendance(employee(), "2025-01-07"),
          overtimeMinutes: null,
        },
      ])
      .mockResolvedValueOnce([known]);

    const result = await getReport(admin, { ...filters, page: 2, pageSize: 1 });

    expect(result).toMatchObject({
      total: 7,
      summary: { overtimeMinutes: 35, unknownOvertimeRecords: 1 },
    });
    if (result instanceof Response) throw new Error("Expected JSON page");
    expect(result.items.map((row) => row.overtimeMinutes)).toEqual([35]);
  });

  it("returns zero totals for an empty report", async () => {
    mocks.attendances.mockResolvedValue([]);
    mocks.employees.mockResolvedValue([]);

    expect(await getReport(admin, filters)).toMatchObject({
      total: 0,
      items: [],
      summary: { overtimeMinutes: 0, unknownOvertimeRecords: 0 },
    });
  });

  it("keeps the total and displayed overtime consistent during a concurrent correction", async () => {
    const scanned = { ...attendance(), overtimeMinutes: 45 };
    mocks.attendances
      .mockResolvedValueOnce([scanned])
      .mockResolvedValueOnce([{ ...scanned, overtimeMinutes: 120 }]);

    const result = await getReport(admin, {
      ...filters,
      from: "2025-01-06",
      to: "2025-01-06",
    });

    expect(result).toMatchObject({
      summary: { overtimeMinutes: 45, unknownOvertimeRecords: 0 },
    });
    if (result instanceof Response) throw new Error("Expected JSON page");
    expect(result.items.map((row) => row.overtimeMinutes)).toEqual([45]);
  });
});

describe("attendance PDF exports", () => {
  it("explains why a previous approval no longer excuses corrected attendance", async () => {
    const record = attendance();
    mocks.attendances.mockResolvedValue([
      {
        ...record,
        lateApproval: {
          status: "APPROVED",
          checkInAt: new Date("2025-01-06T09:20:00Z"),
          lateMinutes: 20,
        },
      },
    ]);
    await getReport(admin, {
      ...filters,
      from: "2025-01-06",
      to: "2025-01-06",
      status: "LATE",
      format: "pdf",
    });
    const document = mocks.pdf.mock.calls[0][0];
    expect(document.rows[0][8]).toBe(
      "LATE\nLate approval: approved\nApproval no longer matches attendance",
    );
  });

  it("exports excused status alongside actual late minutes without creating overtime", async () => {
    const record = attendance();
    mocks.attendances.mockResolvedValue([
      {
        ...record,
        checkOutAt: new Date("2025-01-06T17:30:00Z"),
        scheduledEndAt: new Date("2025-01-06T17:00:00Z"),
        overtimeMinutes: 30,
        lateApproval: {
          status: "APPROVED",
          checkInAt: record.checkInAt,
          lateMinutes: 30,
        },
      },
    ]);
    await getReport(admin, {
      ...filters,
      from: "2025-01-06",
      to: "2025-01-06",
      status: "PRESENT",
      format: "pdf",
    });
    const document = mocks.pdf.mock.calls[0][0];
    expect(document.rows).toHaveLength(1);
    expect(document.rows[0][3]).toBe("2025-01-06\n09:30");
    expect(document.rows[0][6]).toBe("0h 0m");
    expect(document.rows[0][7]).toBe("30");
    expect(document.rows[0][8]).toBe("PRESENT\nExcused late");
    expect(document.summary).toContainEqual({
      label: "Total overtime",
      value: "0h 0m (0 min)",
    });
  });

  it("exports all filtered records and exact overtime totals regardless of pagination", async () => {
    const records = [
      { ...attendance(employee(), "2025-01-05"), overtimeMinutes: 40 },
      { ...attendance(employee(), "2025-01-06"), overtimeMinutes: 90 },
      { ...attendance(employee(), "2025-01-07"), overtimeMinutes: null },
    ];
    mocks.attendances.mockResolvedValue(records);
    const result = await getReport(admin, {
      ...filters,
      employeeId: "employee-1",
      from: "2025-01-05",
      to: "2025-01-07",
      format: "pdf",
      page: 2,
      pageSize: 1,
    });
    if (!(result instanceof Response)) throw new Error("Expected PDF export");
    expect(result.headers.get("Content-Type")).toBe("application/pdf");
    expect(result.headers.get("Content-Disposition")).toContain(
      "attendance-2025-01-05-to-2025-01-07.pdf",
    );
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(await result.text()).toMatch(/^%PDF-/);
    const document = mocks.pdf.mock.calls[0][0];
    expect(document.title).toBe("Attendance report");
    expect(document.subtitle).toContain("Employee: Employee (E001)");
    expect(document.rows).toHaveLength(3);
    expect(document.rows.map((row: string[]) => row[6])).toEqual([
      "Unknown",
      "1h 30m",
      "0h 40m",
    ]);
    expect(document.summary).toContainEqual({
      label: "Total overtime",
      value: "2h 10m (130 min)",
    });
    expect(document.footerNote).toContain(
      "excludes 1 record with unknown overtime",
    );
    expect(mocks.attendances.mock.calls[0][0].where.employeeId).toBe(
      "employee-1",
    );
  });

  it("prints full late reasons as text and localizes punches to the shift timezone", async () => {
    const record = {
      ...attendance(),
      lateReason: '=Train delay, "signal issue"\nNo service.',
      shift: { ...shift, timezone: "Asia/Dhaka" },
    };
    mocks.attendances.mockResolvedValue([record]);
    await getReport(admin, {
      ...filters,
      from: "2025-01-06",
      to: "2025-01-06",
      format: "pdf",
    });
    const document = mocks.pdf.mock.calls[0][0];
    expect(document.rows[0][3]).toBe("2025-01-06\n15:30");
    expect(document.rows[0][4]).toBe("2025-01-06\n23:00");
    expect(document.rows[0][9]).toBe(record.lateReason);
    expect(JSON.stringify(document)).not.toContain("private-test-address");
    expect(JSON.stringify(document)).not.toContain("checkInLatitude");
  });

  it("gives derived days zero overtime and identifies their source", async () => {
    await getReport(admin, { ...filters, format: "pdf" });
    const document = mocks.pdf.mock.calls[0][0];
    expect(document.rows).toHaveLength(7);
    expect(document.rows[0][6]).toBe("0h 0m");
    expect(document.rows[0][8]).toBe("ABSENT\nScheduled day");
  });

  it("creates an empty report with its date range and zero totals", async () => {
    mocks.attendances.mockResolvedValue([]);
    mocks.employees.mockResolvedValue([]);
    await getReport(admin, { ...filters, format: "pdf" });
    expect(mocks.pdf).toHaveBeenCalledWith(
      expect.objectContaining({
        subtitle: ["Date range: 2025-01-01 to 2025-01-07"],
        rows: [],
        summary: expect.arrayContaining([
          { label: "Records", value: "0" },
          { label: "Total overtime", value: "0h 0m (0 min)" },
        ]),
      }),
    );
  });
});

describe("live dashboard", () => {
  it.each(["PENDING", "APPROVED", "REJECTED"] as const)(
    "counts effective late attendance for %s requests",
    async (status) => {
      const record = attendance(employee(), "2025-01-08");
      mocks.attendances.mockResolvedValue([
        {
          ...record,
          lateApproval: {
            status,
            checkInAt: record.checkInAt,
            lateMinutes: 30,
          },
        },
      ]);
      const result = await getAdminDashboard(admin, now);
      expect(result.lateToday).toBe(status === "APPROVED" ? 0 : 1);
      expect(result.recentAttendance[0]).toMatchObject({
        status: status === "APPROVED" ? "PRESENT" : "LATE",
        actualStatus: "LATE",
        lateApprovalStatus: status,
      });
    },
  );

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

    await expect(getAdminDashboard(admin, now)).rejects.toMatchObject({
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

    await expect(getAdminDashboard(admin, now)).rejects.toMatchObject({
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

    await expect(getAdminDashboard(admin, now)).resolves.toMatchObject({
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
    const result = await getAdminDashboard(
      admin,
      new Date("2025-01-07T03:00:00Z"),
    );
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
    const first = await getAdminDashboard(admin, now);
    mocks.attendances.mockResolvedValue([attendance(employee(), "2025-01-08")]);
    const second = await getAdminDashboard(admin, now);
    expect(first.presentToday).toBe(0);
    expect(second.presentToday).toBe(1);
  });
});
