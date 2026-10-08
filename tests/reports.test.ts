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
    checkOutAt: new Date(`${day}T18:00:00Z`),
    lateMinutes: 30,
    lateReason: "Train service was delayed.",
    workedMinutes: 510,
    overtimeMinutes: 0,
    employee: target,
    office: target.office,
    shift,
    checkInLatitude: 99,
    checkInIp: "private-test-address",
  };
}
function lateDeductionAttendance(extraMinutes: number, day = "2025-01-06") {
  const scheduledEndAt = new Date(`${day}T17:00:00Z`);
  return {
    ...attendance(employee(), day),
    checkInAt: new Date(`${day}T08:06:00Z`),
    checkOutAt: new Date(scheduledEndAt.getTime() + extraMinutes * 60_000),
    scheduledEndAt,
    lateMinutes: 6,
    workedMinutes: 534 + extraMinutes,
    overtimeMinutes: extraMinutes - 6,
    shift: { ...shift, startTime: "08:00" },
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
      workedMinutes: 480,
      overtimeMinutes: 30,
    };
    mocks.attendances.mockResolvedValue([record]);
    const result = await getReport(admin, {
      ...filters,
      from: "2025-01-06",
      to: "2025-01-06",
    });
    expect(result).toMatchObject({
      summary: { overtimeMinutes: -60, unknownOvertimeRecords: 0 },
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
      summary: { overtimeMinutes: 0, unknownOvertimeRecords: 0 },
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
    "excludes signed shortfalls and deducts recorded lateness across pages when viewing page %i",
    async (page) => {
      const records = [
        {
          ...attendance(employee(), "2025-01-07"),
          checkOutAt: new Date("2025-01-07T16:00:00Z"),
          workedMinutes: 390,
          scheduledEndAt: new Date("2025-01-07T17:00:00Z"),
          overtimeMinutes: 0,
        },
        {
          ...attendance(employee(), "2025-01-06"),
          checkOutAt: new Date("2025-01-06T18:00:00Z"),
          scheduledEndAt: new Date("2025-01-06T17:00:00Z"),
          overtimeMinutes: 60,
        },
      ];
      mocks.attendances
        .mockResolvedValueOnce(records)
        .mockResolvedValueOnce([records[page - 1]]);

      const result = await getReport(admin, {
        ...filters,
        from: "2025-01-06",
        to: "2025-01-07",
        page,
        pageSize: 1,
      });

      expect(result).toMatchObject({
        total: 2,
        summary: { overtimeMinutes: -150, unknownOvertimeRecords: 0 },
        items: [{ overtimeMinutes: page === 1 ? -90 : 30 }],
      });
    },
  );

  it.each([1, 2, 3])(
    "applies the 30-minute minimum to each record while preserving page %i overtime",
    async (page) => {
      const records = [
        { ...attendance(employee(), "2025-01-07"), overtimeMinutes: 29 },
        { ...attendance(employee(), "2025-01-06"), overtimeMinutes: 29 },
        { ...attendance(employee(), "2025-01-05"), overtimeMinutes: 30 },
      ];
      mocks.attendances
        .mockResolvedValueOnce(records)
        .mockResolvedValueOnce([records[page - 1]]);

      const result = await getReport(admin, {
        ...filters,
        from: "2025-01-05",
        to: "2025-01-07",
        page,
        pageSize: 1,
      });

      expect(result).toMatchObject({
        total: 3,
        summary: { overtimeMinutes: -60, unknownOvertimeRecords: 0 },
        items: [{ overtimeMinutes: records[page - 1].overtimeMinutes }],
      });
    },
  );

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
        summary: { overtimeMinutes: 20, unknownOvertimeRecords: 0 },
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
      summary: { overtimeMinutes: 17, unknownOvertimeRecords: 0 },
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
      summary: { overtimeMinutes: 15, unknownOvertimeRecords: 0 },
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
      summary: { overtimeMinutes: -25, unknownOvertimeRecords: 1 },
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
    mocks.attendances.mockResolvedValueOnce([scanned]).mockResolvedValueOnce([
      {
        ...scanned,
        overtimeMinutes: 120,
        lateMinutes: 5,
        workedMinutes: 480,
      },
    ]);

    const result = await getReport(admin, {
      ...filters,
      from: "2025-01-06",
      to: "2025-01-06",
    });

    expect(result).toMatchObject({
      summary: { overtimeMinutes: 15, unknownOvertimeRecords: 0 },
    });
    if (result instanceof Response) throw new Error("Expected JSON page");
    expect(result.items.map((row) => row.overtimeMinutes)).toEqual([45]);
    expect(result.items.map((row) => row.lateMinutes)).toEqual([30]);
    expect(result.items.map((row) => row.workedMinutes)).toEqual([510]);
  });
});

describe("fixed deductions for recorded lateness", () => {
  it.each([
    [0, 90],
    [5, 90],
    [6, 60],
    [10, 60],
    [90, 60],
  ])(
    "deducts a fixed 30 minutes only when Late(min) is above five (%i)",
    async (lateMinutes, total) => {
      mocks.attendances.mockResolvedValue([
        {
          ...attendance(),
          checkInAt: new Date(
            date("2025-01-06").getTime() + (9 * 60 + lateMinutes) * 60_000,
          ),
          checkOutAt: new Date(
            date("2025-01-06").getTime() +
              (9 * 60 + lateMinutes + 510) * 60_000,
          ),
          lateMinutes,
          overtimeMinutes: 90,
        },
      ]);
      const result = await getReport(admin, {
        ...filters,
        from: "2025-01-06",
        to: "2025-01-06",
      });
      expect(result).toMatchObject({
        summary: { overtimeMinutes: total, unknownOvertimeRecords: 0 },
        items: [{ overtimeMinutes: 90, lateMinutes }],
      });
    },
  );

  it.each([
    {
      extra: 0,
      overtime: -6,
      total: 60,
      display: "-0h 6m",
      pdfTotal: "1h 0m (60 min)",
    },
    {
      extra: 20,
      overtime: 14,
      total: 60,
      display: "0h 14m",
      pdfTotal: "1h 0m (60 min)",
    },
    {
      extra: 30,
      overtime: 24,
      total: 60,
      display: "0h 24m",
      pdfTotal: "1h 0m (60 min)",
    },
    {
      extra: 60,
      overtime: 54,
      total: 114,
      display: "0h 54m",
      pdfTotal: "1h 54m (114 min)",
    },
    {
      extra: 120,
      overtime: 114,
      total: 174,
      display: "1h 54m",
      pdfTotal: "2h 54m (174 min)",
    },
  ])(
    "retains a fixed deduction after $extra extra minutes in every JSON page and PDF",
    async ({ extra, overtime, total, display, pdfTotal }) => {
      const records = [
        {
          ...attendance(employee(), "2025-01-07"),
          status: "PRESENT",
          checkInAt: new Date("2025-01-07T09:00:00Z"),
          lateMinutes: 0,
          overtimeMinutes: 90,
        },
        lateDeductionAttendance(extra),
      ];
      for (const page of [1, 2]) {
        mocks.attendances
          .mockResolvedValueOnce(records)
          .mockResolvedValueOnce([records[page - 1]]);
        const result = await getReport(admin, {
          ...filters,
          from: "2025-01-06",
          to: "2025-01-07",
          page,
          pageSize: 1,
        });
        expect(result).toMatchObject({
          total: 2,
          summary: { overtimeMinutes: total, unknownOvertimeRecords: 0 },
          items: [{ overtimeMinutes: page === 1 ? 90 : overtime }],
        });
        expect(JSON.stringify(result)).not.toContain(
          "lateMakeupShortfallMinutes",
        );
      }
      mocks.attendances.mockResolvedValue(records);
      await getReport(admin, {
        ...filters,
        from: "2025-01-06",
        to: "2025-01-07",
        format: "pdf",
        page: 2,
        pageSize: 1,
      });
      const document = mocks.pdf.mock.calls[0][0];
      expect(document.rows.map((row: string[]) => row[6])).toEqual([
        "1h 30m",
        display,
      ]);
      expect(document.summary).toContainEqual({
        label: "Total overtime",
        value: pdfTotal,
      });
    },
  );

  it("deducts recorded lateness after approval while retaining excused status", async () => {
    const record = {
      ...attendance(),
      checkInAt: new Date("2025-01-06T09:06:00Z"),
      lateMinutes: 6,
      overtimeMinutes: 90,
    };
    mocks.attendances.mockResolvedValue([
      {
        ...record,
        lateApproval: {
          status: "APPROVED",
          checkInAt: record.checkInAt,
          lateMinutes: 6,
        },
      },
    ]);
    const result = await getReport(admin, {
      ...filters,
      from: "2025-01-06",
      to: "2025-01-06",
      status: "PRESENT",
    });
    expect(result).toMatchObject({
      summary: { overtimeMinutes: 60, unknownOvertimeRecords: 0 },
      items: [
        {
          status: "PRESENT",
          lateMinutes: 6,
          actualLateMinutes: 6,
          effectiveLateMinutes: 0,
          isExcusedLate: true,
          overtimeMinutes: 90,
        },
      ],
    });
  });

  it.each([
    { kind: "unknown historical", overtime: null, open: false, unknown: 1 },
    { kind: "zero historical", overtime: 0, open: false, unknown: 0 },
    { kind: "negative historical", overtime: -90, open: false, unknown: 0 },
    { kind: "open", overtime: 0, open: true, unknown: 0 },
  ])(
    "deducts known lateness even for $kind overtime",
    async ({ overtime, open, unknown }) => {
      mocks.attendances.mockResolvedValue([
        {
          ...attendance(),
          scheduledEndAt: null,
          checkOutAt: open ? null : new Date("2025-01-06T18:00:00Z"),
          overtimeMinutes: overtime,
        },
      ]);
      const result = await getReport(admin, {
        ...filters,
        from: "2025-01-06",
        to: "2025-01-06",
      });
      expect(result).toMatchObject({
        summary: { overtimeMinutes: -30, unknownOvertimeRecords: unknown },
        items: [{ overtimeMinutes: overtime, lateMinutes: 30 }],
      });
      await getReport(admin, {
        ...filters,
        from: "2025-01-06",
        to: "2025-01-06",
        format: "pdf",
      });
      expect(mocks.pdf.mock.calls[0][0].summary).toContainEqual({
        label: "Total overtime",
        value: "-0h 30m (-30 min)",
      });
    },
  );
});

describe("completed workday shortages", () => {
  it.each([
    {
      worked: 509,
      late: 0,
      overtime: 0,
      total: -1,
      unknown: 0,
      pdfTotal: "-0h 1m (-1 min)",
    },
    {
      worked: 510,
      late: 0,
      overtime: 0,
      total: 0,
      unknown: 0,
      pdfTotal: "0h 0m (0 min)",
    },
    {
      worked: 511,
      late: 0,
      overtime: 0,
      total: 0,
      unknown: 0,
      pdfTotal: "0h 0m (0 min)",
    },
    {
      worked: 480,
      late: 0,
      overtime: 0,
      total: -30,
      unknown: 0,
      pdfTotal: "-0h 30m (-30 min)",
    },
    {
      worked: 480,
      late: 6,
      overtime: 0,
      total: -60,
      unknown: 0,
      pdfTotal: "-1h 0m (-60 min)",
    },
    {
      worked: 480,
      late: 6,
      overtime: 90,
      total: 30,
      unknown: 0,
      pdfTotal: "0h 30m (30 min)",
    },
    {
      worked: 480,
      late: 0,
      overtime: -30,
      total: -30,
      unknown: 0,
      pdfTotal: "-0h 30m (-30 min)",
    },
    {
      worked: 480,
      late: 0,
      overtime: null,
      total: -30,
      unknown: 1,
      pdfTotal: "-0h 30m (-30 min)",
    },
  ])(
    "deducts shortages for $worked completed minutes with Late(min) $late and overtime $overtime in JSON and PDF",
    async ({ worked, late, overtime, total, unknown, pdfTotal }) => {
      const checkInAt = new Date(
        date("2025-01-06").getTime() + (9 * 60 + late) * 60_000,
      );
      const record = {
        ...attendance(),
        status: late > 0 ? "LATE" : "PRESENT",
        checkInAt,
        checkOutAt: new Date(checkInAt.getTime() + worked * 60_000),
        lateMinutes: late,
        workedMinutes: worked,
        overtimeMinutes: overtime,
      };
      mocks.attendances.mockResolvedValue([record]);
      const result = await getReport(admin, {
        ...filters,
        from: "2025-01-06",
        to: "2025-01-06",
      });
      expect(result).toMatchObject({
        summary: { overtimeMinutes: total, unknownOvertimeRecords: unknown },
        items: [{ workedMinutes: worked, overtimeMinutes: overtime }],
      });
      await getReport(admin, {
        ...filters,
        from: "2025-01-06",
        to: "2025-01-06",
        format: "pdf",
      });
      expect(mocks.pdf.mock.calls[0][0].summary).toContainEqual({
        label: "Total overtime",
        value: pdfTotal,
      });
    },
  );

  it.each([
    { kind: "open attendance", checkIn: true, checkOut: false },
    { kind: "checkout without check-in", checkIn: false, checkOut: true },
    { kind: "unpunched attendance", checkIn: false, checkOut: false },
  ])(
    "does not deduct a workday shortage for $kind",
    async ({ checkIn, checkOut }) => {
      mocks.attendances.mockResolvedValue([
        {
          ...attendance(),
          checkInAt: checkIn ? new Date("2025-01-06T09:00:00Z") : null,
          checkOutAt: checkOut ? new Date("2025-01-06T17:00:00Z") : null,
          lateMinutes: 0,
          workedMinutes: 0,
        },
      ]);
      const result = await getReport(admin, {
        ...filters,
        from: "2025-01-06",
        to: "2025-01-06",
      });
      expect(result).toMatchObject({
        summary: { overtimeMinutes: 0, unknownOvertimeRecords: 0 },
      });
      await getReport(admin, {
        ...filters,
        from: "2025-01-06",
        to: "2025-01-06",
        format: "pdf",
      });
      expect(mocks.pdf.mock.calls[0][0].summary).toContainEqual({
        label: "Total overtime",
        value: "0h 0m (0 min)",
      });
    },
  );

  it("does not deduct shortages for derived absence, leave, holiday, or weekend days", async () => {
    mocks.attendances.mockResolvedValue([]);
    const result = await getReport(admin, filters);
    if (result instanceof Response) throw new Error("Expected JSON report");
    expect(result.summary.overtimeMinutes).toBe(0);
    expect(result.items.map((row) => row.status)).toEqual(
      expect.arrayContaining(["ABSENT", "LEAVE", "HOLIDAY", "WEEKEND"]),
    );
    expect(
      result.items.every((row) => row.derived && row.workedMinutes === 0),
    ).toBe(true);
    await getReport(admin, { ...filters, format: "pdf" });
    expect(mocks.pdf.mock.calls[0][0].summary).toContainEqual({
      label: "Total overtime",
      value: "0h 0m (0 min)",
    });
  });

  it("deducts shortages and late penalties across all pages and respects the status filter", async () => {
    const records = [
      {
        ...attendance(employee(), "2025-01-07"),
        status: "PRESENT",
        lateMinutes: 0,
        workedMinutes: 600,
        overtimeMinutes: 90,
      },
      {
        ...attendance(),
        lateMinutes: 6,
        workedMinutes: 480,
        overtimeMinutes: 0,
      },
    ];
    for (const page of [1, 2]) {
      mocks.attendances
        .mockResolvedValueOnce(records)
        .mockResolvedValueOnce([records[page - 1]]);
      const result = await getReport(admin, {
        ...filters,
        from: "2025-01-06",
        to: "2025-01-07",
        page,
        pageSize: 1,
      });
      expect(result).toMatchObject({
        total: 2,
        summary: { overtimeMinutes: 30, unknownOvertimeRecords: 0 },
        items: [{ workedMinutes: records[page - 1].workedMinutes }],
      });
    }
    mocks.attendances.mockResolvedValue(records);
    await getReport(admin, {
      ...filters,
      from: "2025-01-06",
      to: "2025-01-07",
      page: 2,
      pageSize: 1,
      format: "pdf",
    });
    expect(mocks.pdf.mock.calls[0][0].summary).toContainEqual({
      label: "Total overtime",
      value: "0h 30m (30 min)",
    });
    const filtered = await getReport(admin, {
      ...filters,
      from: "2025-01-06",
      to: "2025-01-07",
      status: "PRESENT",
    });
    expect(filtered).toMatchObject({
      total: 1,
      summary: { overtimeMinutes: 90, unknownOvertimeRecords: 0 },
    });
  });

  it("retains the scanned workday shortage when a correction occurs during hydration", async () => {
    const scanned = { ...attendance(), lateMinutes: 0, workedMinutes: 480 };
    mocks.attendances
      .mockResolvedValueOnce([scanned])
      .mockResolvedValueOnce([{ ...scanned, workedMinutes: 510 }]);
    const result = await getReport(admin, {
      ...filters,
      from: "2025-01-06",
      to: "2025-01-06",
    });
    expect(result).toMatchObject({
      summary: { overtimeMinutes: -30, unknownOvertimeRecords: 0 },
      items: [{ workedMinutes: 480 }],
    });
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
        workedMinutes: 480,
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
      value: "-1h 0m (-60 min)",
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
      value: "0h 40m (40 min)",
    });
    expect(document.footerNote).toContain(
      "excludes 1 record with unknown overtime",
    );
    expect(mocks.attendances.mock.calls[0][0].where.employeeId).toBe(
      "employee-1",
    );
  });

  it("exports excluded overtime rows and colors without including them in the total", async () => {
    mocks.attendances.mockResolvedValue([
      { ...attendance(employee(), "2025-01-05"), overtimeMinutes: 30 },
      { ...attendance(employee(), "2025-01-06"), overtimeMinutes: -90 },
      { ...attendance(employee(), "2025-01-07"), overtimeMinutes: null },
      { ...attendance(employee(), "2025-01-04"), overtimeMinutes: 29 },
    ]);
    await getReport(admin, {
      ...filters,
      from: "2025-01-04",
      to: "2025-01-07",
      format: "pdf",
    });
    const document = mocks.pdf.mock.calls[0][0];
    expect(document.rows.map((row: string[]) => row[6])).toEqual([
      "Unknown",
      "-1h 30m",
      "0h 30m",
      "0h 29m",
    ]);
    expect(
      document.cellTextColors.map((row: (string | undefined)[]) => row[6]),
    ).toEqual([undefined, "#B42318", "#176B4A", "#B42318"]);
    expect(document.summary).toContainEqual({
      label: "Total overtime",
      value: "-1h 30m (-90 min)",
    });
    expect(document.footerNote).toContain(
      "Negative overtime shows a work-hour shortfall",
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
    expect(document.rows[0][4]).toBe("2025-01-07\n00:00");
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

describe("localized attendance exports", () => {
  it("translates Chinese report labels while retaining timezone, notes and calculations", async () => {
    const record = {
      ...attendance(),
      shift: { ...shift, timezone: "Asia/Dhaka" },
      overtimeMinutes: -90,
      lateReason: "Train delay / 用户填写",
    };
    mocks.attendances.mockResolvedValue([record]);
    const selected = {
      ...filters,
      from: "2025-01-06",
      to: "2025-01-06",
      format: "pdf" as const,
    };
    const result = await getReport(admin, selected, "zh-CN");
    expect(result).toBeInstanceOf(Response);
    const document = mocks.pdf.mock.calls[0][0];
    expect(document.locale).toBe("zh-CN");
    expect(document.title).toBe("考勤报表");
    expect(document.columns[3].label).toBe("签到");
    expect(document.rows[0][1]).toBe("Employee\nE001");
    expect(document.rows[0][2]).toBe("HQ\nDay\nAsia/Dhaka");
    expect(document.rows[0][3]).toBe("2025/01/06\n15:30");
    expect(document.rows[0][4]).toBe("2025/01/07\n00:00");
    expect(document.rows[0][6]).toBe("-1 小时 30 分钟");
    expect(document.rows[0][7]).toBe("30");
    expect(document.rows[0][8]).toBe("迟到");
    expect(document.rows[0][9]).toBe(record.lateReason);
    expect(document.summary).toContainEqual({
      label: "总加班时长",
      value: "-0 小时 30 分钟（-30 分钟）",
    });
    if (result instanceof Response)
      expect(result.headers.get("Content-Disposition")).toContain(
        "attendance-2025-01-06-to-2025-01-06.pdf",
      );
  });

  it("leaves JSON enums, timestamps and summary amounts unchanged between locales", async () => {
    const english = await getReport(admin, filters, "en");
    const chinese = await getReport(admin, filters, "zh-CN");
    expect(chinese).toEqual(english);
    expect(mocks.pdf).not.toHaveBeenCalled();
  });

  it("retains role authorization for Chinese reports", async () => {
    await expect(
      getReport({ id: "employee", role: "EMPLOYEE" }, filters, "zh-CN"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.attendances).not.toHaveBeenCalled();
  });
});
