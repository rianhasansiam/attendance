-- Keep the existing timestamp convention used by attendance punches.
-- New check-ins snapshot their scheduled end so future Shift edits do not
-- change overtime. Legacy open records establish this snapshot at checkout.
ALTER TABLE "Attendance"
  ADD COLUMN "scheduledEndAt" TIMESTAMP(3),
  ADD COLUMN "overtimeMinutes" INTEGER DEFAULT 0;

-- Completed historical rows have no trustworthy schedule snapshot. Display
-- unknown overtime instead of silently treating today's Shift as historical.
UPDATE "Attendance" SET "overtimeMinutes" = NULL
WHERE "checkOutAt" IS NOT NULL;

ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_overtime_valid" CHECK (
  "overtimeMinutes" IS NULL OR (
    "overtimeMinutes" >= 0 AND "overtimeMinutes" <= "workedMinutes"
    AND ("overtimeMinutes" = 0 OR (
      "checkInAt" IS NOT NULL AND "checkOutAt" IS NOT NULL
      AND "scheduledEndAt" IS NOT NULL
    ))
  )
);
