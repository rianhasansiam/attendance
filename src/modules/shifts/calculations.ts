import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

export interface ShiftDefinition {
  startTime: string;
  endTime: string;
  timezone: string;
  graceMinutes: number;
  halfDayThreshold: number;
}

export function shiftDate(date: Date, timezone: string): string {
  return formatInTimeZone(date, timezone, "yyyy-MM-dd");
}

export function addCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function getShiftWindow(
  now: Date,
  shift: ShiftDefinition,
  attendanceDate?: string,
) {
  let day = attendanceDate ?? shiftDate(now, shift.timezone);
  const overnight = shift.endTime <= shift.startTime;
  // The after-midnight portion belongs to the previous shift's calendar date.
  if (
    !attendanceDate &&
    overnight &&
    formatInTimeZone(now, shift.timezone, "HH:mm") < shift.endTime
  ) {
    day = addCalendarDays(day, -1);
  }
  const endDay = overnight ? addCalendarDays(day, 1) : day;
  return {
    attendanceDate: new Date(`${day}T00:00:00.000Z`),
    startsAt: fromZonedTime(`${day}T${shift.startTime}:00`, shift.timezone),
    endsAt: fromZonedTime(`${endDay}T${shift.endTime}:00`, shift.timezone),
  };
}

export function calculateCheckIn(
  now: Date,
  startsAt: Date,
  graceMinutes: number,
) {
  const elapsed = (now.getTime() - startsAt.getTime()) / 60_000;
  // Late minutes measure lateness from the scheduled start; grace determines status.
  return {
    status: elapsed > graceMinutes ? ("LATE" as const) : ("PRESENT" as const),
    lateMinutes: elapsed > graceMinutes ? Math.ceil(elapsed) : 0,
  };
}

export function calculateCheckOut(
  checkInAt: Date,
  checkOutAt: Date,
  halfDayThreshold: number,
  lateMinutes: number,
  scheduledEndAt: Date | null,
) {
  const workedMinutes = Math.max(
    0,
    Math.floor((checkOutAt.getTime() - checkInAt.getTime()) / 60_000),
  );
  return {
    workedMinutes,
    overtimeMinutes: calculateOvertime(
      checkInAt,
      checkOutAt,
      lateMinutes,
      scheduledEndAt,
    ).overtimeMinutes,
    status:
      workedMinutes < halfDayThreshold
        ? ("HALF_DAY" as const)
        : lateMinutes > 0
          ? ("LATE" as const)
          : ("PRESENT" as const),
  };
}

/** Approval never changes the actual lateness used to offset overtime. */
export function calculateOvertime(
  checkInAt: Date,
  checkOutAt: Date,
  actualLateMinutes: number,
  scheduledEndAt: Date | null,
) {
  // Preserve unknown overtime when no historical schedule was captured.
  if (!scheduledEndAt)
    return { rawOvertimeMinutes: null, overtimeMinutes: null };
  // Only completed minutes actually worked after the scheduled end count.
  const rawOvertimeMinutes = Math.max(
    0,
    Math.floor(
      (checkOutAt.getTime() -
        Math.max(checkInAt.getTime(), scheduledEndAt.getTime())) /
        60_000,
    ),
  );
  return {
    rawOvertimeMinutes,
    overtimeMinutes: Math.max(0, rawOvertimeMinutes - actualLateMinutes),
  };
}
