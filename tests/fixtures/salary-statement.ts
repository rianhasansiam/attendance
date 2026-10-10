import type {
  SalaryAttendanceDTO,
  SalaryCalculationDTO,
} from "../../src/modules/salary/contracts";
import {
  calculateSalaryAmounts,
  countSalaryPayableDays,
} from "../../src/modules/salary/calculations";

/** Synthetic fixtures only; no private employee data is used in sample documents. */
export function salaryStatementFixture(
  options: {
    rows?: number;
    longName?: boolean;
    ongoing?: boolean;
    period?: string;
    from?: string;
    to?: string;
    monthlyBaseSalary?: string;
    configuredWeekendDays?: number[];
    overtimePerRecordedDay?: number;
  } = {},
): SalaryCalculationDTO {
  const period = options.period ?? options.from?.slice(0, 7) ?? "2026-10";
  const from = options.from ?? `${period}-01`;
  const lastDay = new Date(`${period}-01T12:00:00.000Z`);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1);
  lastDay.setUTCDate(0);
  const to = options.to ?? lastDay.toISOString().slice(0, 10);
  const start = Date.parse(`${from}T12:00:00.000Z`);
  const rangeDays =
    Math.round((Date.parse(`${to}T12:00:00.000Z`) - start) / 86400000) + 1;
  const count = options.rows ?? rangeDays;
  const attendance: SalaryAttendanceDTO[] = Array.from(
    { length: count },
    (_, index) => {
      const date = new Date(start + (index % rangeDays) * 86400000)
        .toISOString()
        .slice(0, 10);
      const special = index % rangeDays;
      const statuses = [
        "LEAVE",
        "HOLIDAY",
        "WEEKEND",
        "ABSENT",
        "PRESENT",
        "LATE",
      ];
      const incomplete = special === 4;
      const recorded = special >= 4;
      const configuredWeekends = options.configuredWeekendDays ?? [5, 6];
      const status =
        special === 2 &&
        !configuredWeekends.includes(new Date(`${date}T12:00:00Z`).getUTCDay())
          ? "LEAVE"
          : special < 6
            ? statuses[special]
            : "PRESENT";
      const payable =
        options.overtimePerRecordedDay === undefined
          ? special >= 6
            ? 30
            : 0
          : recorded && !incomplete
            ? options.overtimePerRecordedDay
            : 0;
      return {
        id: `attendance-${String(index).padStart(3, "0")}`,
        date,
        checkInAt: recorded ? `${date}T03:00:00.000Z` : null,
        checkOutAt: recorded && !incomplete ? `${date}T12:30:00.000Z` : null,
        workedMinutes: recorded && !incomplete ? 570 : 0,
        payableOvertimeMinutes: payable,
        status,
        actualStatus: status,
        lateMinutes: special === 5 ? 15 : 0,
        effectiveLateMinutes: special === 5 ? 15 : 0,
        isExcusedLate: false,
        lateApprovalStatus: null,
        incomplete,
        derived: !recorded,
        timezone: "Asia/Dhaka",
      };
    },
  ).reverse(); // Deliberately unsorted to exercise the generator's chronological order.
  const payableOvertimeMinutes = attendance.reduce(
    (sum, row) => sum + row.payableOvertimeMinutes,
    0,
  );
  const workedMinutes = attendance.reduce(
    (sum, row) => sum + row.workedMinutes,
    0,
  );
  const payDays = countSalaryPayableDays(
    from,
    to,
    options.configuredWeekendDays ?? [5, 6],
  );
  const amounts = calculateSalaryAmounts(
    options.monthlyBaseSalary ?? "30000.00",
    "200.00",
    payableOvertimeMinutes,
    payDays.payableDays,
  );
  return {
    employee: {
      id: "sample-employee",
      employeeCode: "EMP001",
      name: options.longName
        ? "Alexandra Mohammed Rahman Chowdhury International Operations and Regional Coordination Representative"
        : "Alexandra Rahman",
      email: "sample.employee@example.test",
      department: options.longName ? null : "Operations",
      designation: options.longName ? null : "Operations Coordinator",
      officeName: "Dhaka Office",
    },
    period,
    from,
    to,
    generatedAt: options.ongoing
      ? `${to}T17:55:00.000Z`
      : new Date(Date.parse(`${to}T03:05:00.000Z`) + 86400000).toISOString(),
    timezone: "Asia/Dhaka",
    currency: "BDT",
    ...amounts,
    ...payDays,
    payableOvertimeMinutes,
    ongoing: options.ongoing ?? false,
    settings: {
      id: "salary-setting-fixture",
      effectiveMonth: period,
      revision: 1,
      baseSalary: amounts.monthlyBaseSalary,
      overtimeHourlyRate: "200.00",
      createdAt: "2026-09-30T00:00:00.000Z",
      createdBy: null,
    },
    attendance,
    summary: {
      workedMinutes,
      payableOvertimeMinutes,
      records: attendance.length,
      unknownOvertimeRecords: 0,
      statusCounts: attendance.reduce<Record<string, number>>((counts, row) => {
        counts[row.status] = (counts[row.status] ?? 0) + 1;
        return counts;
      }, {}),
    },
    token: "sample-fixture-server-token-not-a-real-authorization",
  };
}
