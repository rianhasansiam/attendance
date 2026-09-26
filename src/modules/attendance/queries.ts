import type { Prisma } from "@prisma/client";

// Display reads remain dynamic; avoid retrieving GPS, IP or credential evidence.
export const attendanceDisplaySelect = {
  id: true,
  attendanceDate: true,
  checkInAt: true,
  checkOutAt: true,
  status: true,
  lateMinutes: true,
  lateReason: true,
  workedMinutes: true,
  overtimeMinutes: true,
  scheduledStartAt: true,
  scheduledEndAt: true,
  lateApproval: {
    select: { id: true, status: true, checkInAt: true, lateMinutes: true },
  },
} satisfies Prisma.AttendanceSelect;
