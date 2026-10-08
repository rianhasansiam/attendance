export const MINIMUM_COUNTED_OVERTIME_MINUTES = 30;
const LATE_OVERTIME_DEDUCTION_THRESHOLD_MINUTES = 5;
const LATE_OVERTIME_DEDUCTION_MINUTES = 30;
const REQUIRED_WORKDAY_MINUTES = 510;

/** Apply the minimum to each attendance record before adding overtime totals. */
export function isCountedOvertime(minutes: number | null | undefined): boolean {
  return minutes != null && minutes >= MINIMUM_COUNTED_OVERTIME_MINUTES;
}

export function countedOvertimeMinutes(
  minutes: number | null | undefined,
  lateMinutes = 0,
  completedWorkedMinutes?: number | null,
): number {
  const credit = minutes != null && isCountedOvertime(minutes) ? minutes : 0;
  const deduction =
    lateMinutes > LATE_OVERTIME_DEDUCTION_THRESHOLD_MINUTES
      ? LATE_OVERTIME_DEDUCTION_MINUTES
      : 0;
  const workdayShortage =
    completedWorkedMinutes == null
      ? 0
      : Math.max(0, REQUIRED_WORKDAY_MINUTES - completedWorkedMinutes);
  return credit - deduction - workdayShortage;
}
