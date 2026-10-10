import { z } from "zod";
import { businessDateSchema } from "@/modules/daily-expenses/contracts";

export const SALARY_MONTHLY_DIVISOR = 26;

export const salaryPeriodSchema = z
  .string()
  .regex(
    /^(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])$/,
    "Choose a valid payroll month (YYYY-MM), from 1900 to 2199.",
  );

export function salaryMonthBounds(period: string) {
  salaryPeriodSchema.parse(period);
  const first = new Date(`${period}-01T00:00:00.000Z`);
  const next = new Date(first);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return {
    from: first.toISOString().slice(0, 10),
    to: new Date(next.valueOf() - 86400000).toISOString().slice(0, 10),
  };
}

export const salaryDateSchema = businessDateSchema;
const salaryRangeFields = {
  period: salaryPeriodSchema,
  from: salaryDateSchema.optional(),
  to: salaryDateSchema.optional(),
};

export function validateSalaryRange(
  value: { period: string; from?: string; to?: string },
  context: z.RefinementCtx,
) {
  if ((value.from === undefined) !== (value.to === undefined)) {
    context.addIssue({
      code: "custom",
      path: [value.from === undefined ? "from" : "to"],
      message:
        "Choose both the start and end dates, or leave both out for the full month.",
    });
    return;
  }
  if (value.from === undefined || value.to === undefined) return;
  if (value.from > value.to)
    context.addIssue({
      code: "custom",
      path: ["to"],
      message: "The end date must be on or after the start date.",
    });
  const dates = { from: value.from, to: value.to };
  for (const key of ["from", "to"] as const)
    if (!dates[key].startsWith(`${value.period}-`))
      context.addIssue({
        code: "custom",
        path: [key],
        message: "Both dates must be within the selected payroll month.",
      });
}

function normalizeSalaryRange<
  T extends { period: string; from?: string; to?: string },
>(value: T) {
  const defaults = salaryMonthBounds(value.period);
  return {
    ...value,
    from: value.from ?? defaults.from,
    to: value.to ?? defaults.to,
  };
}

/** Shared browser/server calendar validation; period-only requests retain full-month behavior. */
export const salaryRangeSchema = z
  .object(salaryRangeFields)
  .strict()
  .superRefine(validateSalaryRange)
  .transform(normalizeSalaryRange);

/** Exact decimal text, including explicitly configured zero. No floating point input. */
export const salaryAmountSchema = z
  .string()
  .trim()
  .regex(
    /^\d{1,16}(?:\.\d{1,2})?$/,
    "Enter a non-negative amount with at most 16 whole digits and 2 decimal places.",
  )
  .transform((value) => {
    const [whole, fraction = ""] = value.split(".");
    return `${whole.replace(/^0+(?=\d)/, "")}.${fraction.padEnd(2, "0")}`;
  });

export const salaryEmployeeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const salarySettingsInputSchema = z
  .object({
    effectiveMonth: salaryPeriodSchema,
    baseSalary: salaryAmountSchema,
    overtimeHourlyRate: salaryAmountSchema,
  })
  .strict();

function pageNumber(max: number, fallback: number) {
  return z
    .union([
      z.number(),
      z
        .string()
        .regex(/^\d{1,6}$/)
        .transform(Number),
    ])
    .pipe(z.number().int().min(1).max(max))
    .default(fallback);
}

export const salaryQuerySchema = z
  .object({
    ...salaryRangeFields,
    search: z.string().trim().max(200).optional(),
    departmentId: salaryEmployeeIdSchema.optional(),
    officeId: salaryEmployeeIdSchema.optional(),
    page: pageNumber(100000, 1),
    pageSize: pageNumber(100, 20),
  })
  .strict()
  .superRefine(validateSalaryRange)
  .transform(normalizeSalaryRange);
export const salaryCalculateInputSchema = z
  .object({
    ...salaryRangeFields,
    employeeIds: z
      .array(salaryEmployeeIdSchema)
      .min(1)
      .max(100)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Choose each employee only once.",
      ),
  })
  .strict()
  .superRefine(validateSalaryRange)
  .transform(normalizeSalaryRange);
export const salaryExportInputSchema = z
  .object({
    employeeId: salaryEmployeeIdSchema,
    ...salaryRangeFields,
    token: z.string().min(1).max(2000),
  })
  .strict()
  .superRefine(validateSalaryRange)
  .transform(normalizeSalaryRange);

export type SalarySettingsInput = z.input<typeof salarySettingsInputSchema>;
export type SalaryQuery = z.input<typeof salaryQuerySchema>;
export type SalaryCalculateInput = z.input<typeof salaryCalculateInputSchema>;
export type SalaryExportInput = z.input<typeof salaryExportInputSchema>;
export type SalaryEmployeeDTO = {
  id: string;
  employeeCode: string;
  name: string | null;
  email: string;
  department: string | null;
  designation: string | null;
  officeName: string;
};
export type SalarySettingsDTO = {
  id: string;
  effectiveMonth: string;
  revision: number;
  baseSalary: string;
  overtimeHourlyRate: string;
  createdAt: string;
  createdBy: { id: string; name: string | null; email: string } | null;
};
export type SalaryEmployeePageDTO = {
  items: { employee: SalaryEmployeeDTO; settings: SalarySettingsDTO | null }[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  period: string;
  from: string;
  to: string;
  today: string;
  ongoing: boolean;
  currentPeriod: string;
  currency: string;
  timezone: string;
};
export type SalaryAttendanceDTO = {
  id: string;
  date: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  workedMinutes: number;
  payableOvertimeMinutes: number;
  status: string;
  actualStatus: string;
  lateMinutes: number;
  effectiveLateMinutes: number;
  isExcusedLate: boolean;
  lateApprovalStatus: string | null;
  incomplete: boolean;
  derived: boolean;
  timezone: string;
};
export type SalaryCalculationDTO = {
  employee: SalaryEmployeeDTO;
  period: string;
  from: string;
  to: string;
  generatedAt: string;
  timezone: string;
  currency: string;
  monthlyBaseSalary: string;
  dailyRate: string;
  salaryDivisor: typeof SALARY_MONTHLY_DIVISOR;
  calendarDays: number;
  weekendDays: number;
  payableDays: number;
  weekendDates: string[];
  configuredWeekendDays: number[];
  baseSalary: string;
  overtimeHourlyRate: string;
  payableOvertimeMinutes: number;
  overtimeEarnings: string;
  totalSalary: string;
  ongoing: boolean;
  settings: SalarySettingsDTO;
  attendance: SalaryAttendanceDTO[];
  summary: {
    workedMinutes: number;
    payableOvertimeMinutes: number;
    records: number;
    unknownOvertimeRecords: number;
    statusCounts: Record<string, number>;
  };
  token: string;
};

export type SalaryStatementData = SalaryCalculationDTO;
