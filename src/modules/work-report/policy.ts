import { DomainError } from "@/lib/errors";
import { todayInTimezone } from "@/modules/daily-expenses/contracts";

export { todayInTimezone };
export function workReportTimezone(): string {
  const timezone = (
    process.env.WORK_REPORT_TIMEZONE ??
    process.env.OFFICE_WORK_TIMEZONE ??
    process.env.DAILY_EXPENSES_TIMEZONE ??
    "Asia/Dhaka"
  ).trim();
  try {
    todayInTimezone(timezone);
  } catch {
    throw new Error("Invalid Work Report business timezone.");
  }
  return timezone;
}
export function workReportConflict(): DomainError {
  return new DomainError(
    "WORK_REPORT_CONFLICT",
    "This report changed. Refresh and review it before trying again.",
    409,
  );
}
