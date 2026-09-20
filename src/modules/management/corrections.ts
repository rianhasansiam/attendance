import type { AttendanceStatus } from "@prisma/client";
import type { z } from "zod";
import { DomainError } from "@/lib/errors";
import {
  calculateCheckIn,
  calculateCheckOut,
  getShiftWindow,
  type ShiftDefinition,
} from "@/modules/shifts/calculations";
import type { correctionSchema } from "./validation";

export function calculateCorrection(
  previous: {
    checkInAt: Date | null;
    checkOutAt: Date | null;
    attendanceDate: Date;
    shift: ShiftDefinition;
  },
  input: z.infer<typeof correctionSchema>,
  now = new Date(),
) {
  const checkInAt =
    input.checkInAt === undefined
      ? previous.checkInAt
      : input.checkInAt === null
        ? null
        : new Date(input.checkInAt);
  const checkOutAt =
    input.checkOutAt === undefined
      ? previous.checkOutAt
      : input.checkOutAt === null
        ? null
        : new Date(input.checkOutAt);
  if (checkOutAt && (!checkInAt || checkOutAt < checkInAt))
    throw new DomainError(
      "INVALID_ATTENDANCE_TIME",
      "Check-out must be after check-in.",
    );
  if (
    checkInAt &&
    checkOutAt &&
    checkOutAt.valueOf() - checkInAt.valueOf() > 48 * 3600000
  )
    throw new DomainError(
      "INVALID_ATTENDANCE_TIME",
      "Working duration cannot exceed 48 hours.",
    );
  if ((checkInAt && checkInAt > now) || (checkOutAt && checkOutAt > now))
    throw new DomainError(
      "FUTURE_ATTENDANCE",
      "Attendance times cannot be in the future.",
    );
  const window = getShiftWindow(
    checkInAt ?? now,
    previous.shift,
    previous.attendanceDate.toISOString().slice(0, 10),
  );
  if (
    checkInAt &&
    (checkInAt.valueOf() < window.startsAt.valueOf() - 12 * 3600000 ||
      checkInAt.valueOf() > window.endsAt.valueOf())
  )
    throw new DomainError(
      "ATTENDANCE_DATE_MISMATCH",
      "The check-in time must belong to this attendance date's shift.",
    );
  const arrival = checkInAt
    ? calculateCheckIn(checkInAt, window.startsAt, previous.shift.graceMinutes)
    : { lateMinutes: 0, status: "ABSENT" as const };
  const departure =
    checkInAt && checkOutAt
      ? calculateCheckOut(
          checkInAt,
          checkOutAt,
          previous.shift.halfDayThreshold,
          arrival.lateMinutes,
        )
      : null;
  const status: AttendanceStatus =
    input.status ?? departure?.status ?? arrival.status;
  if (
    ["ABSENT", "LEAVE", "HOLIDAY", "WEEKEND"].includes(status) &&
    (checkInAt || checkOutAt)
  )
    throw new DomainError(
      "STATUS_TIME_CONFLICT",
      "A non-working status requires empty attendance times.",
    );
  if (["PRESENT", "LATE", "HALF_DAY"].includes(status) && !checkInAt)
    throw new DomainError(
      "STATUS_TIME_CONFLICT",
      "This status requires a check-in time.",
    );
  return {
    checkInAt,
    checkOutAt,
    status,
    lateMinutes: arrival.lateMinutes,
    workedMinutes: departure?.workedMinutes ?? 0,
  };
}
