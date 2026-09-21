-- Run after migration.sql, in the SAME transaction on an isolated rehearsal first.
-- The original migration's remaining CHECKs, partial unique indexes, and
-- append-only history triggers must remain in place. Do not use db push.

ALTER TABLE "Shift" ADD CONSTRAINT "Shift_policy_valid" CHECK (
  "startMinute" BETWEEN 0 AND 1439
  AND "endMinute" BETWEEN 0 AND 1439
  AND "startMinute" <> "endMinute"
  AND "graceMinutes" >= 0 AND "halfDayThreshold" > 0
);

ALTER TABLE "Office" ADD CONSTRAINT "Office_weekend_days_valid" CHECK (
  "weekendDays" IS NOT NULL
  AND coalesce(array_ndims("weekendDays"), 1) = 1
  AND "weekendDays" <@ ARRAY[0, 1, 2, 3, 4, 5, 6]
  AND array_position("weekendDays", NULL) IS NULL
  AND cardinality("weekendDays") <= 7
);

ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_snapshot_valid" CHECK (
  num_nonnulls("scheduledStartAt", "scheduledEndAt", "graceMinutesSnapshot",
    "halfDayThresholdSnapshot", "timezoneSnapshot") = 0
  OR (
    num_nonnulls("scheduledStartAt", "scheduledEndAt", "graceMinutesSnapshot",
      "halfDayThresholdSnapshot", "timezoneSnapshot") = 5
    AND "scheduledEndAt" > "scheduledStartAt"
    AND "graceMinutesSnapshot" >= 0
    AND "halfDayThresholdSnapshot" > 0
    AND length(trim("timezoneSnapshot")) > 0
    AND ("scheduledStartAt" AT TIME ZONE "timezoneSnapshot")::date = "attendanceDate"
  )
);

-- Keep unknown legacy history nullable, but never create new unknown history.
-- The CHECK above enforces the complete group on every write. This trigger
-- distinguishes legacy rows from new rows without adding a migration flag.
CREATE FUNCTION enforce_attendance_snapshot_presence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."scheduledStartAt" IS NULL THEN
      RAISE EXCEPTION 'New attendance requires a complete schedule snapshot'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD."scheduledStartAt" IS NOT NULL AND NEW."scheduledStartAt" IS NULL THEN
    RAISE EXCEPTION 'An established attendance snapshot cannot be cleared'
      USING ERRCODE = '23514';
  ELSIF OLD."checkInAt" IS NULL AND NEW."checkInAt" IS NOT NULL
      AND NEW."scheduledStartAt" IS NULL THEN
    RAISE EXCEPTION 'A new check-in requires a complete schedule snapshot'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Attendance_snapshot_presence"
  BEFORE INSERT OR UPDATE ON "Attendance"
  FOR EACH ROW EXECUTE FUNCTION enforce_attendance_snapshot_presence();

ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_location_valid" CHECK (
  ("checkInLatitude" IS NULL) = ("checkInLongitude" IS NULL)
  AND ("checkOutLatitude" IS NULL) = ("checkOutLongitude" IS NULL)
  AND ("checkInLatitude" IS NULL OR "checkInLatitude" BETWEEN -90 AND 90)
  AND ("checkInLongitude" IS NULL OR "checkInLongitude" BETWEEN -180 AND 180)
  AND ("checkOutLatitude" IS NULL OR "checkOutLatitude" BETWEEN -90 AND 90)
  AND ("checkOutLongitude" IS NULL OR "checkOutLongitude" BETWEEN -180 AND 180)
  AND ("checkInAccuracy" IS NULL OR
    ("checkInAccuracy" >= 0 AND "checkInAccuracy" < 'Infinity'::double precision))
  AND ("checkOutAccuracy" IS NULL OR
    ("checkOutAccuracy" >= 0 AND "checkOutAccuracy" < 'Infinity'::double precision))
  AND ("checkInDistanceMeters" IS NULL OR
    ("checkInDistanceMeters" >= 0 AND "checkInDistanceMeters" < 'Infinity'::double precision))
  AND ("checkOutDistanceMeters" IS NULL OR
    ("checkOutDistanceMeters" >= 0 AND "checkOutDistanceMeters" < 'Infinity'::double precision))
);

ALTER TABLE "WebAuthnChallenge" ADD CONSTRAINT "WebAuthnChallenge_times_valid" CHECK (
  "expiresAt" > "createdAt"
  AND ("usedAt" IS NULL OR ("usedAt" >= "createdAt" AND "usedAt" < "expiresAt"))
);

ALTER TABLE "RateLimit" ADD CONSTRAINT "RateLimit_count_valid" CHECK ("count" >= 0);

-- One assigned shift per employee per inclusive business date is a current
-- business invariant. A unique (employeeId, startDate) alone cannot enforce it.
-- The extension and exclusion constraint are recorded in migration history;
-- enable extension privileges for the migration role, not the application role.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "EmployeeShift" ADD CONSTRAINT "EmployeeShift_no_overlapping_dates"
  EXCLUDE USING gist (
    "employeeId" WITH =,
    daterange("startDate", "endDate", '[]') WITH &&
  );

-- ALREADY present in 20260919000000_initial: shown here as documentation only.
-- Do not recreate, drop, or replace these with full-column uniqueness:
-- CREATE UNIQUE INDEX "Holiday_global_date_unique"
--   ON "Holiday" ("date") WHERE "officeId" IS NULL;
-- CREATE UNIQUE INDEX "Attendance_one_open_per_employee"
--   ON "Attendance" ("employeeId")
--   WHERE "checkInAt" IS NOT NULL AND "checkOutAt" IS NULL;
-- Also retain User_email_normalized, Office_location_valid,
-- EmployeeShift_dates_valid, Leave_dates_valid, Attendance_times_valid,
-- Credential_counter_valid, and both immutable history triggers.
