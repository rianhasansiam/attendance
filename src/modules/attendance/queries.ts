import type { Prisma } from "@prisma/client";

// Display reads remain dynamic; avoid retrieving GPS, IP or credential evidence.
export const attendanceDisplaySelect = {
  id: true,
  attendanceDate: true,
  checkInAt: true,
  checkOutAt: true,
  status: true,
  lateMinutes: true,
  workedMinutes: true,
} satisfies Prisma.AttendanceSelect;
