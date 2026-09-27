-- Retain the completed-punch and duration safeguards while allowing shortfalls.
ALTER TABLE "Attendance" DROP CONSTRAINT "Attendance_overtime_valid";
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_overtime_valid" CHECK (
  "overtimeMinutes" IS NULL OR (
    "overtimeMinutes" <= "workedMinutes"
    AND ("overtimeMinutes" = 0 OR (
      "checkInAt" IS NOT NULL AND "checkOutAt" IS NOT NULL
      AND "scheduledEndAt" IS NOT NULL
    ))
  )
);

-- Use captured schedules and actual lateness, including approved lateness.
-- Cap positive overtime at the completed minutes actually worked.
-- Keep open attendance and unknown historical schedules unchanged.
UPDATE "Attendance"
SET "overtimeMinutes" = LEAST(
  GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ("checkOutAt" - "checkInAt")) / 60)::INTEGER),
  FLOOR(EXTRACT(EPOCH FROM ("checkOutAt" - "scheduledEndAt")) / 60)::INTEGER
  - "lateMinutes")
WHERE "scheduledEndAt" IS NOT NULL
  AND "checkInAt" IS NOT NULL AND "checkOutAt" IS NOT NULL;
