import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ AUTH_SECRET: "salary-test-secret-at-least-32-characters" }),
}));
import {
  salaryAmountSchema,
  salaryCalculateInputSchema,
  salaryExportInputSchema,
  salaryQuerySchema,
  salaryRangeSchema,
  salarySettingsInputSchema,
} from "@/modules/salary/contracts";
import {
  calculateSalaryAmounts,
  countSalaryPayableDays,
  payrollMonthBounds,
} from "@/modules/salary/calculations";
import {
  SALARY_CALCULATION_MAX_AGE_MS,
  salarySourceDigest,
  signSalaryVersion,
  verifySalaryVersion,
} from "@/modules/salary/version";

describe("salary input and exact money", () => {
  it.each([
    ["0", "0.00"],
    ["000.00", "0.00"],
    ["30000", "30000.00"],
    [" 200.5 ", "200.50"],
  ])("canonicalizes %s", (input, amount) => {
    expect(salaryAmountSchema.parse(input)).toBe(amount);
  });
  it.each([
    "-1",
    "NaN",
    "Infinity",
    "1e3",
    "1.001",
    "",
    0,
    NaN,
    Infinity,
    null,
    "10000000000000000",
  ])("rejects invalid amount %s", (amount) => {
    expect(salaryAmountSchema.safeParse(amount).success).toBe(false);
  });
  it("distinguishes missing settings from explicit zeros and rejects forged totals", () => {
    expect(
      salarySettingsInputSchema.parse({
        effectiveMonth: "2026-10",
        baseSalary: "0",
        overtimeHourlyRate: "0",
      }),
    ).toMatchObject({ baseSalary: "0.00", overtimeHourlyRate: "0.00" });
    for (const extra of [
      { effectiveMonth: "2026-10", baseSalary: "0" },
      { effectiveMonth: "2026-13", baseSalary: "0", overtimeHourlyRate: "0" },
      {
        effectiveMonth: "2026-10",
        baseSalary: "0",
        overtimeHourlyRate: "0",
        totalSalary: "10000",
      },
    ])
      expect(salarySettingsInputSchema.safeParse(extra).success).toBe(false);
    expect(
      salaryCalculateInputSchema.safeParse({
        period: "2026-10",
        employeeIds: ["employee", "employee"],
      }).success,
    ).toBe(false);
    expect(
      salaryCalculateInputSchema.safeParse({
        period: "2026-10",
        employeeIds: ["employee"],
        payableOvertimeMinutes: 999,
      }).success,
    ).toBe(false);
  });
  it("retains fractional hours and zero overtime", () => {
    expect(calculateSalaryAmounts("30000", "200", 750, 26)).toMatchObject({
      baseSalary: "30000.00",
      overtimeHourlyRate: "200.00",
      overtimeEarnings: "2500.00",
      totalSalary: "32500.00",
    });
    expect(calculateSalaryAmounts("0", "0", 0, 0).totalSalary).toBe("0.00");
    expect(calculateSalaryAmounts("30000", "200", 0, 26).overtimeEarnings).toBe(
      "0.00",
    );
  });
  it("rounds final currency earnings once, half up, at high precision", () => {
    expect(calculateSalaryAmounts("0.10", "0.01", 30, 26)).toMatchObject({
      overtimeEarnings: "0.01",
      totalSalary: "0.11",
    });
    expect(calculateSalaryAmounts("0.10", "0.01", 10, 26)).toMatchObject({
      overtimeEarnings: "0.00",
      totalSalary: "0.10",
    });
    expect(
      calculateSalaryAmounts(
        "9999999999999999.99",
        "9999999999999999.99",
        750,
        26,
      ),
    ).toMatchObject({
      overtimeEarnings: "124999999999999999.88",
      totalSalary: "134999999999999999.87",
    });
  });
  it("retains authoritative signed payable overtime adjustments", () => {
    expect(calculateSalaryAmounts("30000", "200", -30, 26)).toMatchObject({
      overtimeEarnings: "-100.00",
      totalSalary: "29900.00",
    });
    expect(() => calculateSalaryAmounts("0", "0", 1.5, 26)).toThrow("integer");
  });
  it("uses payroll calendar dates, including leap years and year boundaries", () => {
    expect(payrollMonthBounds("2024-02")).toEqual({
      from: "2024-02-01",
      to: "2024-02-29",
    });
    expect(payrollMonthBounds("2026-12")).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
    expect(() => payrollMonthBounds("2026-00")).toThrow();
  });
});

describe("range base pay and configured office weekends", () => {
  it("calculates nine payable days from the monthly reference divided by 26, then adds fractional-hour overtime", () => {
    expect(calculateSalaryAmounts("18000", "200", 750, 9)).toEqual({
      monthlyBaseSalary: "18000.00",
      dailyRate: "692.31",
      salaryDivisor: 26,
      baseSalary: "6230.77",
      overtimeHourlyRate: "200.00",
      overtimeEarnings: "2500.00",
      totalSalary: "8730.77",
    });
  });
  it("rounds range base once after multiplying the unrounded daily rate", () => {
    expect(calculateSalaryAmounts("1", "0", 0, 9)).toMatchObject({
      dailyRate: "0.04",
      baseSalary: "0.35",
      totalSalary: "0.35",
    });
    expect(calculateSalaryAmounts("0.01", "0.01", 30, 13)).toMatchObject({
      baseSalary: "0.01",
      overtimeEarnings: "0.01",
      totalSalary: "0.02",
    });
    expect(calculateSalaryAmounts("18000", "200", 90, 0)).toMatchObject({
      baseSalary: "0.00",
      overtimeEarnings: "300.00",
      totalSalary: "300.00",
    });
  });
  it.each([
    ["0.17", "0.09"],
    ["0.27", "0.14"],
    ["0.53", "0.27"],
    ["1.05", "0.53"],
    ["9999999999999999.99", "5000000000000000.00"],
  ])(
    "rounds exact half-cent range base correctly for reference %s",
    (monthly, expected) => {
      expect(calculateSalaryAmounts(monthly, "0", 0, 13)).toMatchObject({
        baseSalary: expected,
        totalSalary: expected,
      });
    },
  );
  it("counts both endpoints, excludes configured weekends and retains their exact dates", () => {
    expect(countSalaryPayableDays("2026-09-06", "2026-09-16", [5, 6])).toEqual({
      calendarDays: 11,
      weekendDays: 2,
      payableDays: 9,
      weekendDates: ["2026-09-11", "2026-09-12"],
      configuredWeekendDays: [5, 6],
    });
    expect(
      countSalaryPayableDays("2026-09-11", "2026-09-11", [5, 6]),
    ).toMatchObject({ calendarDays: 1, weekendDays: 1, payableDays: 0 });
    expect(
      countSalaryPayableDays("2026-09-10", "2026-09-10", [5, 6]),
    ).toMatchObject({ calendarDays: 1, weekendDays: 0, payableDays: 1 });
  });
  it("supports Sunday zero, empty and every-day weekend policies", () => {
    expect(
      countSalaryPayableDays("2026-09-06", "2026-09-12", [0]),
    ).toMatchObject({
      calendarDays: 7,
      weekendDays: 1,
      payableDays: 6,
      weekendDates: ["2026-09-06"],
    });
    expect(
      countSalaryPayableDays("2026-09-06", "2026-09-12", []),
    ).toMatchObject({
      calendarDays: 7,
      weekendDays: 0,
      payableDays: 7,
      weekendDates: [],
    });
    expect(
      countSalaryPayableDays("2026-09-06", "2026-09-12", [0, 1, 2, 3, 4, 5, 6]),
    ).toMatchObject({ calendarDays: 7, weekendDays: 7, payableDays: 0 });
  });
  it("uses calendar labels across leap days without timezone-dependent weekday shifts", () => {
    expect(
      countSalaryPayableDays("2024-02-28", "2024-02-29", [4]),
    ).toMatchObject({
      calendarDays: 2,
      weekendDays: 1,
      payableDays: 1,
      weekendDates: ["2024-02-29"],
    });
    expect(
      countSalaryPayableDays("2026-09-01", "2026-09-30", [5, 6]),
    ).toMatchObject({ calendarDays: 30, weekendDays: 8, payableDays: 22 });
  });
  it("rejects invalid payable day counts and invalid office weekday policies", () => {
    for (const days of [-1, 1.5, 32, NaN, Infinity])
      expect(() => calculateSalaryAmounts("0", "0", 0, days)).toThrow(
        "Payable days",
      );
    for (const weekdays of [[-1], [7], [1.5], [0, 0]])
      expect(() =>
        countSalaryPayableDays("2026-09-01", "2026-09-30", weekdays),
      ).toThrow("weekend days");
  });
});

describe("inclusive salary date ranges", () => {
  it("defaults period-only requests to the complete payroll month", () => {
    expect(salaryRangeSchema.parse({ period: "2024-02" })).toEqual({
      period: "2024-02",
      from: "2024-02-01",
      to: "2024-02-29",
    });
    for (const [schema, input] of [
      [salaryQuerySchema, { period: "2026-10" }],
      [
        salaryCalculateInputSchema,
        { period: "2026-10", employeeIds: ["employee"] },
      ],
      [
        salaryExportInputSchema,
        { period: "2026-10", employeeId: "employee", token: "version" },
      ],
    ] as const)
      expect(schema.parse(input)).toMatchObject({
        period: "2026-10",
        from: "2026-10-01",
        to: "2026-10-31",
      });
  });
  it("accepts inclusive subranges and a single calendar date", () => {
    for (const range of [
      { period: "2026-10", from: "2026-10-01", to: "2026-10-15" },
      { period: "2026-10", from: "2026-10-31", to: "2026-10-31" },
      { period: "2024-02", from: "2024-02-28", to: "2024-02-29" },
    ]) {
      expect(salaryRangeSchema.parse(range)).toEqual(range);
      expect(salaryQuerySchema.parse(range)).toMatchObject(range);
      expect(
        salaryCalculateInputSchema.parse({
          ...range,
          employeeIds: ["employee"],
        }),
      ).toMatchObject(range);
      expect(
        salaryExportInputSchema.parse({
          ...range,
          employeeId: "employee",
          token: "version",
        }),
      ).toMatchObject(range);
    }
  });
  it.each([
    { period: "2026-10", from: "2026-10-01" },
    { period: "2026-10", to: "2026-10-31" },
    { period: "2026-10", from: "2026-10-15", to: "2026-10-14" },
    { period: "2026-10", from: "2026-09-30", to: "2026-10-31" },
    { period: "2026-10", from: "2026-10-01", to: "2026-11-01" },
    { period: "2026-10", from: "2026-09-01", to: "2026-09-30" },
    { period: "2026-02", from: "2026-02-01", to: "2026-02-29" },
    { period: "2026-10", from: "2026-10-01", to: "2026-10-32" },
    { period: "2026-10", from: "2026-10-00", to: "2026-10-31" },
    { period: "2026-10", from: "2026-10-1", to: "2026-10-31" },
    { period: "2026-13", from: "2026-13-01", to: "2026-13-31" },
    { period: "2026-10", from: "2026-10-01T00:00:00Z", to: "2026-10-31" },
  ])("rejects an invalid range on every shared input schema: %j", (range) => {
    expect(salaryRangeSchema.safeParse(range).success).toBe(false);
    expect(salaryQuerySchema.safeParse(range).success).toBe(false);
    expect(
      salaryCalculateInputSchema.safeParse({
        ...range,
        employeeIds: ["employee"],
      }).success,
    ).toBe(false);
    expect(
      salaryExportInputSchema.safeParse({
        ...range,
        employeeId: "employee",
        token: "version",
      }).success,
    ).toBe(false);
  });
});

describe("salary preview version", () => {
  const now = new Date("2026-10-10T05:00:00.000Z");
  const payload = {
    actorId: "super-admin",
    employeeId: "employee-1",
    period: "2026-10",
    from: "2026-10-01",
    to: "2026-10-15",
    generatedAt: now.toISOString(),
    sourceDigest: salarySourceDigest({
      baseSalary: "30000.00",
      attendance: ["source"],
    }),
  };
  it("authenticates the full server-owned source, actor, period and generation time", () => {
    const token = signSalaryVersion(payload);
    expect(verifySalaryVersion(token, now)).toEqual(payload);
    const [encoded, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...payload, employeeId: "other" }),
    ).toString("base64url");
    expect(() => verifySalaryVersion(`${forged}.${signature}`, now)).toThrow(
      "Calculate",
    );
    expect(() =>
      verifySalaryVersion(`${encoded}.${"x".repeat(signature.length)}`, now),
    ).toThrow("Calculate");
  });
  it("authenticates both date bounds and rejects range tampering", () => {
    const token = signSalaryVersion(payload);
    const signature = token.split(".")[1];
    for (const range of [{ from: "2026-10-02" }, { to: "2026-10-31" }]) {
      const forged = Buffer.from(
        JSON.stringify({ ...payload, ...range }),
      ).toString("base64url");
      expect(() => verifySalaryVersion(`${forged}.${signature}`, now)).toThrow(
        "Calculate",
      );
    }
    expect(() => signSalaryVersion({ ...payload, from: "2026-09-01" })).toThrow(
      "payroll month",
    );
    expect(() => signSalaryVersion({ ...payload, from: "2026-10-16" })).toThrow(
      "end date",
    );
  });
  it("expires after two hours and rejects future-dated or malformed tokens", () => {
    const token = signSalaryVersion(payload);
    expect(() =>
      verifySalaryVersion(
        token,
        new Date(now.valueOf() + SALARY_CALCULATION_MAX_AGE_MS + 1),
      ),
    ).toThrow("expired");
    expect(() =>
      verifySalaryVersion(token, new Date(now.valueOf() - 1)),
    ).toThrow("expired");
    expect(() => verifySalaryVersion("invalid", now)).toThrow("Calculate");
  });
});
