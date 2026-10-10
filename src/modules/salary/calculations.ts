import { Prisma } from "@prisma/client";
import {
  SALARY_MONTHLY_DIVISOR,
  salaryAmountSchema,
  salaryMonthBounds,
  salaryRangeSchema,
} from "./contracts";

// Rates can contain 16 whole digits. Keep sufficient significant digits during
// the multiplication/division and round currency once, at the final earnings.
const MoneyDecimal = Prisma.Decimal.clone({ precision: 40 });

export function calculateSalaryAmounts(
  monthlyBaseSalary: string,
  overtimeHourlyRate: string,
  payableOvertimeMinutes: number,
  payableDays: number,
) {
  if (!Number.isSafeInteger(payableOvertimeMinutes))
    throw new Error(
      "Payable overtime must be an exact integer number of minutes.",
    );
  if (!Number.isSafeInteger(payableDays) || payableDays < 0 || payableDays > 31)
    throw new Error("Payable days must be an integer between 0 and 31.");
  const monthlyBase = new MoneyDecimal(
    salaryAmountSchema.parse(monthlyBaseSalary),
  );
  const dailyRate = monthlyBase.div(SALARY_MONTHLY_DIVISOR);
  // Multiply the exact reference amount first. Dividing a recurring daily
  // rate first can move an exact half-cent below the final rounding boundary.
  const base = monthlyBase
    .mul(payableDays)
    .div(SALARY_MONTHLY_DIVISOR)
    .toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP);
  const rate = new MoneyDecimal(salaryAmountSchema.parse(overtimeHourlyRate));
  const earnings = rate
    .mul(payableOvertimeMinutes)
    .div(60)
    .toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP);
  return {
    monthlyBaseSalary: monthlyBase.toFixed(2),
    dailyRate: dailyRate.toFixed(2, MoneyDecimal.ROUND_HALF_UP),
    salaryDivisor: SALARY_MONTHLY_DIVISOR as typeof SALARY_MONTHLY_DIVISOR,
    baseSalary: base.toFixed(2),
    overtimeHourlyRate: rate.toFixed(2),
    overtimeEarnings: earnings.toFixed(2),
    totalSalary: base.plus(earnings).toFixed(2),
  };
}

/** Count inclusive calendar labels, independent of attendance classifications. */
export function countSalaryPayableDays(
  from: string,
  to: string,
  configuredWeekendDays: readonly number[],
) {
  salaryRangeSchema.parse({ period: from.slice(0, 7), from, to });
  if (
    configuredWeekendDays.some(
      (day) => !Number.isInteger(day) || day < 0 || day > 6,
    ) ||
    new Set(configuredWeekendDays).size !== configuredWeekendDays.length
  )
    throw new Error(
      "Office weekend days must be unique weekday numbers from 0 to 6.",
    );
  const weekdays = [...configuredWeekendDays].sort((a, b) => a - b);
  const weekends = new Set(weekdays);
  const weekendDates: string[] = [];
  let calendarDays = 0;
  for (
    const date = new Date(`${from}T00:00:00.000Z`);
    date.toISOString().slice(0, 10) <= to;
    date.setUTCDate(date.getUTCDate() + 1)
  ) {
    calendarDays++;
    if (weekends.has(date.getUTCDay()))
      weekendDates.push(date.toISOString().slice(0, 10));
  }
  return {
    calendarDays,
    weekendDays: weekendDates.length,
    payableDays: calendarDays - weekendDates.length,
    weekendDates,
    configuredWeekendDays: weekdays,
  };
}

export function payrollMonthBounds(period: string) {
  return salaryMonthBounds(period);
}
