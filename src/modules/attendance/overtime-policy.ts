export const MINIMUM_COUNTED_OVERTIME_MINUTES = 30;

/** Apply the minimum to each attendance record before adding overtime totals. */
export function isCountedOvertime(minutes: number | null | undefined): boolean {
  return minutes != null && minutes >= MINIMUM_COUNTED_OVERTIME_MINUTES;
}

export function countedOvertimeMinutes(
  minutes: number | null | undefined,
): number {
  if (minutes == null) return 0;
  return isCountedOvertime(minutes) ? minutes : 0;
}
