export const MINIMUM_ELIGIBLE_OVERTIME_MINUTES = 60;
const LATE_OVERTIME_DEDUCTION_THRESHOLD_MINUTES = 5;
const LATE_OVERTIME_DEDUCTION_MINUTES = 30;
const REQUIRED_WORKDAY_MINUTES = 510;

/** Completed work after the captured shift end, before the eligibility minimum. */
export function calculateEligibleOvertime(
  checkInAt: Date,
  checkOutAt: Date,
  scheduledEndAt: Date | null | undefined,
): number | null {
  if (!scheduledEndAt) return null;
  const startsAt = checkInAt.getTime();
  const endsAt = checkOutAt.getTime();
  const dutyEndAt = scheduledEndAt.getTime();
  if (
    ![startsAt, endsAt, dutyEndAt].every(Number.isFinite) ||
    endsAt < startsAt
  )
    return null;
  return Math.max(
    0,
    Math.floor((endsAt - Math.max(startsAt, dutyEndAt)) / 60_000),
  );
}

/** Official credit is approval-derived; attendance deductions remain independent. */
export function countedOvertimeMinutes({
  approvedOvertimeMinutes,
  lateMinutes = 0,
  completedWorkedMinutes,
}: {
  approvedOvertimeMinutes: number;
  lateMinutes?: number;
  completedWorkedMinutes?: number | null;
}): number {
  const deduction =
    lateMinutes > LATE_OVERTIME_DEDUCTION_THRESHOLD_MINUTES
      ? LATE_OVERTIME_DEDUCTION_MINUTES
      : 0;
  const workdayShortage =
    completedWorkedMinutes == null
      ? 0
      : Math.max(0, REQUIRED_WORKDAY_MINUTES - completedWorkedMinutes);
  return approvedOvertimeMinutes - deduction - workdayShortage;
}
