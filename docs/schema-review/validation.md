# Schema proposal PostgreSQL rehearsal

Run: 2026-09-21T03:26:51.884Z

Result: PASSED; 80 checks passed.

Run command: `node docs/schema-review/validation.mjs`. The script creates its own temporary PostgreSQL cluster with TCP disabled; it does not load .env or use DATABASE_URL.

Fixture directory: `/var/folders/8x/gv0lxy4d6rv7hf6tttnhhq840000gn/T/attendance-schema-review-yb52W3`.

```text
PostgreSQL 18.6 (Homebrew); private Unix socket; TCP disabled; no application credentials.
PASS existing migration 20260919000000_initial
PASS existing migration 20260920000000_attendance_recent_index
PASS existing migration 20260921000000_attendance_late_reason
PASS representative legacy fixture covers all 18 models, 11 event types, nullable fields, overnight and normal shifts
PASS unknown historical event prevents deployment without dropping history [22P02]
PASS orphan legacy reviewer prevents deployment [23503 / Leave_reviewedById_fkey]
PASS overlapping legacy assignment prevents deployment [23P01 / EmployeeShift_no_overlapping_dates]
PASS failed migration transaction fully restores original Shift columns and schema
PASS proposal migration.sql plus constraints.sql commits as one transaction
PASS all 35 original timestamp columns preserve every non-null instant and null despite non-UTC session
PASS all original instant columns converted to timestamp with time zone
PASS every remaining original column value preserved across all fixture rows, including SQL dates, relationships, JSON, arrays, counters, and bytes
PASS all 18 model row counts preserved
PASS HH:mm conversion preserves 09:00–17:30 and 22:00–06:00
PASS historical schedules remain all-null; no fabricated snapshot backfill
PASS overnight business date preserved as PostgreSQL date
PASS all 11 enum event types and append-only history rows preserved
PASS audit JSON and WebAuthn public-key material preserved
PASS negative shift minute [23514 / Shift_policy_valid]
PASS minute 1440 rejected [23514 / Shift_policy_valid]
PASS equal shift endpoints rejected [23514 / Shift_policy_valid]
PASS negative grace rejected [23514 / Shift_policy_valid]
PASS zero half-day threshold rejected [23514 / Shift_policy_valid]
PASS negative geofence radius rejected [23514 / Office_location_valid]
PASS zero GPS accuracy limit rejected [23514 / Office_location_valid]
PASS invalid office latitude rejected [23514 / Office_location_valid]
PASS invalid weekend value rejected [23514 / Office_weekend_days_valid]
PASS null weekend element rejected [23514 / Office_weekend_days_valid]
PASS negative work duration rejected [23514 / Attendance_times_valid]
PASS negative lateness rejected [23514 / Attendance_times_valid]
PASS checkout before checkin rejected [23514 / Attendance_times_valid]
PASS unpaired coordinate rejected [23514 / Attendance_location_valid]
PASS partial snapshots rejected [23514 / Attendance_snapshot_valid]
PASS new attendance without snapshots rejected [23514]
PASS new check-in on legacy no-punch row requires snapshots [23514]
PASS complete snapshot cannot be cleared [23514]
PASS snapshot missing timezone rejected [23514 / Attendance_snapshot_valid]
PASS reversed snapshot endpoints rejected [23514 / Attendance_snapshot_valid]
PASS wrong business date snapshot rejected [23514 / Attendance_snapshot_valid]
PASS negative rate-limit count rejected [23514 / RateLimit_count_valid]
PASS challenge expires at creation rejected [23514 / WebAuthnChallenge_times_valid]
PASS challenge used before creation rejected [23514 / WebAuthnChallenge_times_valid]
PASS challenge used at expiry rejected [23514 / WebAuthnChallenge_times_valid]
PASS orphan leave reviewer rejected [23503 / Leave_reviewedById_fkey]
PASS referenced reviewer deletion rejected [23001 / Leave_reviewedById_fkey]
PASS reversed leave dates rejected [23514 / Leave_dates_valid]
PASS reversed assignment dates rejected [23514 / EmployeeShift_dates_valid]
PASS overlapping assignment rejected [23P01 / EmployeeShift_no_overlapping_dates]
PASS duplicate global holiday rejected [23505 / Holiday_global_date_unique]
PASS duplicate office holiday rejected [23505 / Holiday_officeId_date_key]
PASS second open attendance rejected [23505 / Attendance_one_open_per_employee]
PASS duplicate business date rejected [23505 / Attendance_employeeId_attendanceDate_key]
PASS unknown new event type rejected [22P02]
PASS event UPDATE remains forbidden [P0001]
PASS event DELETE remains forbidden [P0001]
PASS audit UPDATE remains forbidden [P0001]
PASS audit DELETE remains forbidden [P0001]
PASS checkInAccuracy rejects '-1' [23514 / Attendance_location_valid]
PASS checkInAccuracy rejects 'NaN' [23514 / Attendance_location_valid]
PASS checkInAccuracy rejects 'Infinity' [23514 / Attendance_location_valid]
PASS checkInAccuracy rejects '-Infinity' [23514 / Attendance_location_valid]
PASS checkOutAccuracy rejects '-1' [23514 / Attendance_location_valid]
PASS checkOutAccuracy rejects 'NaN' [23514 / Attendance_location_valid]
PASS checkOutAccuracy rejects 'Infinity' [23514 / Attendance_location_valid]
PASS checkOutAccuracy rejects '-Infinity' [23514 / Attendance_location_valid]
PASS checkInDistanceMeters rejects '-1' [23514 / Attendance_location_valid]
PASS checkInDistanceMeters rejects 'NaN' [23514 / Attendance_location_valid]
PASS checkInDistanceMeters rejects 'Infinity' [23514 / Attendance_location_valid]
PASS checkInDistanceMeters rejects '-Infinity' [23514 / Attendance_location_valid]
PASS checkOutDistanceMeters rejects '-1' [23514 / Attendance_location_valid]
PASS checkOutDistanceMeters rejects 'NaN' [23514 / Attendance_location_valid]
PASS checkOutDistanceMeters rejects 'Infinity' [23514 / Attendance_location_valid]
PASS checkOutDistanceMeters rejects '-Infinity' [23514 / Attendance_location_valid]
PASS valid complete overnight snapshot accepted
PASS valid GPS zero accuracy/distance accepted
PASS empty weekend set accepted
PASS adjacent inclusive assignment ranges accepted
PASS null leave reviewer retained for pending request
PASS all replacement/new indexes exist; redundant superseded indexes absent; original partial unique indexes preserved
PASS every final constraint is validated

Final index definitions:
CREATE UNIQUE INDEX "Account_pkey" ON public."Account" USING btree (id);
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON public."Account" USING btree (provider, "providerAccountId");
CREATE INDEX "Account_userId_idx" ON public."Account" USING btree ("userId");
CREATE INDEX "AttendanceEvent_attendanceId_createdAt_id_idx" ON public."AttendanceEvent" USING btree ("attendanceId", "createdAt" DESC, id DESC);
CREATE INDEX "AttendanceEvent_createdAt_id_idx" ON public."AttendanceEvent" USING btree ("createdAt" DESC, id DESC);
CREATE INDEX "AttendanceEvent_employeeId_createdAt_id_idx" ON public."AttendanceEvent" USING btree ("employeeId", "createdAt" DESC, id DESC);
CREATE UNIQUE INDEX "AttendanceEvent_pkey" ON public."AttendanceEvent" USING btree (id);
CREATE INDEX "AttendanceEvent_type_createdAt_id_idx" ON public."AttendanceEvent" USING btree (type, "createdAt" DESC, id DESC);
CREATE UNIQUE INDEX "Attendance_employeeId_attendanceDate_key" ON public."Attendance" USING btree ("employeeId", "attendanceDate");
CREATE INDEX "Attendance_officeId_attendanceDate_idx" ON public."Attendance" USING btree ("officeId", "attendanceDate");
CREATE UNIQUE INDEX "Attendance_one_open_per_employee" ON public."Attendance" USING btree ("employeeId") WHERE (("checkInAt" IS NOT NULL) AND ("checkOutAt" IS NULL));
CREATE UNIQUE INDEX "Attendance_pkey" ON public."Attendance" USING btree (id);
CREATE INDEX "Attendance_shiftId_attendanceDate_idx" ON public."Attendance" USING btree ("shiftId", "attendanceDate");
CREATE INDEX "Attendance_status_attendanceDate_idx" ON public."Attendance" USING btree (status, "attendanceDate");
CREATE INDEX "Attendance_updatedAt_id_idx" ON public."Attendance" USING btree ("updatedAt" DESC, id DESC);
CREATE INDEX "AuditLog_actorId_createdAt_id_idx" ON public."AuditLog" USING btree ("actorId", "createdAt" DESC, id DESC);
CREATE INDEX "AuditLog_createdAt_id_idx" ON public."AuditLog" USING btree ("createdAt" DESC, id DESC);
CREATE UNIQUE INDEX "AuditLog_pkey" ON public."AuditLog" USING btree (id);
CREATE INDEX "AuditLog_resource_resourceId_createdAt_id_idx" ON public."AuditLog" USING btree (resource, "resourceId", "createdAt" DESC, id DESC);
CREATE UNIQUE INDEX "Department_name_key" ON public."Department" USING btree (name);
CREATE UNIQUE INDEX "Department_pkey" ON public."Department" USING btree (id);
CREATE INDEX "EmployeeShift_employeeId_endDate_idx" ON public."EmployeeShift" USING btree ("employeeId", "endDate");
CREATE UNIQUE INDEX "EmployeeShift_employeeId_startDate_key" ON public."EmployeeShift" USING btree ("employeeId", "startDate");
CREATE INDEX "EmployeeShift_no_overlapping_dates" ON public."EmployeeShift" USING gist ("employeeId", daterange("startDate", "endDate", '[]'::text));
CREATE UNIQUE INDEX "EmployeeShift_pkey" ON public."EmployeeShift" USING btree (id);
CREATE INDEX "Employee_departmentId_idx" ON public."Employee" USING btree ("departmentId");
CREATE UNIQUE INDEX "Employee_employeeCode_key" ON public."Employee" USING btree ("employeeCode");
CREATE INDEX "Employee_officeId_idx" ON public."Employee" USING btree ("officeId");
CREATE UNIQUE INDEX "Employee_pkey" ON public."Employee" USING btree (id);
CREATE UNIQUE INDEX "Employee_userId_key" ON public."Employee" USING btree ("userId");
CREATE INDEX "Holiday_date_idx" ON public."Holiday" USING btree (date);
CREATE UNIQUE INDEX "Holiday_global_date_unique" ON public."Holiday" USING btree (date) WHERE ("officeId" IS NULL);
CREATE UNIQUE INDEX "Holiday_officeId_date_key" ON public."Holiday" USING btree ("officeId", date);
CREATE UNIQUE INDEX "Holiday_pkey" ON public."Holiday" USING btree (id);
CREATE INDEX "Leave_employeeId_startDate_endDate_idx" ON public."Leave" USING btree ("employeeId", "startDate", "endDate");
CREATE UNIQUE INDEX "Leave_pkey" ON public."Leave" USING btree (id);
CREATE INDEX "Leave_status_createdAt_id_idx" ON public."Leave" USING btree (status, "createdAt" DESC, id DESC);
CREATE UNIQUE INDEX "OfficeNetwork_officeId_publicIpOrCidr_key" ON public."OfficeNetwork" USING btree ("officeId", "publicIpOrCidr");
CREATE UNIQUE INDEX "OfficeNetwork_pkey" ON public."OfficeNetwork" USING btree (id);
CREATE UNIQUE INDEX "Office_pkey" ON public."Office" USING btree (id);
CREATE UNIQUE INDEX "RateLimit_pkey" ON public."RateLimit" USING btree (key);
CREATE INDEX "RateLimit_resetAt_idx" ON public."RateLimit" USING btree ("resetAt");
CREATE INDEX "Session_expires_idx" ON public."Session" USING btree (expires);
CREATE UNIQUE INDEX "Session_pkey" ON public."Session" USING btree (id);
CREATE UNIQUE INDEX "Session_sessionToken_key" ON public."Session" USING btree ("sessionToken");
CREATE INDEX "Session_userId_idx" ON public."Session" USING btree ("userId");
CREATE UNIQUE INDEX "Shift_pkey" ON public."Shift" USING btree (id);
CREATE UNIQUE INDEX "SystemSetting_pkey" ON public."SystemSetting" USING btree (key);
CREATE UNIQUE INDEX "User_email_key" ON public."User" USING btree (email);
CREATE UNIQUE INDEX "User_googleAccountId_key" ON public."User" USING btree ("googleAccountId");
CREATE UNIQUE INDEX "User_pkey" ON public."User" USING btree (id);
CREATE INDEX "User_status_role_idx" ON public."User" USING btree (status, role);
CREATE UNIQUE INDEX "WebAuthnChallenge_challenge_key" ON public."WebAuthnChallenge" USING btree (challenge);
CREATE INDEX "WebAuthnChallenge_context_idx" ON public."WebAuthnChallenge" USING btree ("employeeId", purpose, "sessionId", "usedAt", "expiresAt");
CREATE INDEX "WebAuthnChallenge_expiresAt_idx" ON public."WebAuthnChallenge" USING btree ("expiresAt");
CREATE UNIQUE INDEX "WebAuthnChallenge_pkey" ON public."WebAuthnChallenge" USING btree (id);
CREATE UNIQUE INDEX "WebAuthnCredential_credentialId_key" ON public."WebAuthnCredential" USING btree ("credentialId");
CREATE INDEX "WebAuthnCredential_employeeId_revokedAt_idx" ON public."WebAuthnCredential" USING btree ("employeeId", "revokedAt");
CREATE UNIQUE INDEX "WebAuthnCredential_pkey" ON public."WebAuthnCredential" USING btree (id);

Final check/exclusion definitions:
"Attendance".Attendance_location_valid: CHECK (((("checkInLatitude" IS NULL) = ("checkInLongitude" IS NULL)) AND (("checkOutLatitude" IS NULL) = ("checkOutLongitude" IS NULL)) AND (("checkInLatitude" IS NULL) OR (("checkInLatitude" >= ('-90'::integer)::double precision) AND ("checkInLatitude" <= (90)::double precision))) AND (("checkInLongitude" IS NULL) OR (("checkInLongitude" >= ('-180'::integer)::double precision) AND ("checkInLongitude" <= (180)::double precision))) AND (("checkOutLatitude" IS NULL) OR (("checkOutLatitude" >= ('-90'::integer)::double precision) AND ("checkOutLatitude" <= (90)::double precision))) AND (("checkOutLongitude" IS NULL) OR (("checkOutLongitude" >= ('-180'::integer)::double precision) AND ("checkOutLongitude" <= (180)::double precision))) AND (("checkInAccuracy" IS NULL) OR (("checkInAccuracy" >= (0)::double precision) AND ("checkInAccuracy" < 'Infinity'::double precision))) AND (("checkOutAccuracy" IS NULL) OR (("checkOutAccuracy" >= (0)::double precision) AND ("checkOutAccuracy" < 'Infinity'::double precision))) AND (("checkInDistanceMeters" IS NULL) OR (("checkInDistanceMeters" >= (0)::double precision) AND ("checkInDistanceMeters" < 'Infinity'::double precision))) AND (("checkOutDistanceMeters" IS NULL) OR (("checkOutDistanceMeters" >= (0)::double precision) AND ("checkOutDistanceMeters" < 'Infinity'::double precision)))))
"Attendance".Attendance_snapshot_valid: CHECK (((num_nonnulls("scheduledStartAt", "scheduledEndAt", "graceMinutesSnapshot", "halfDayThresholdSnapshot", "timezoneSnapshot") = 0) OR ((num_nonnulls("scheduledStartAt", "scheduledEndAt", "graceMinutesSnapshot", "halfDayThresholdSnapshot", "timezoneSnapshot") = 5) AND ("scheduledEndAt" > "scheduledStartAt") AND ("graceMinutesSnapshot" >= 0) AND ("halfDayThresholdSnapshot" > 0) AND (length(TRIM(BOTH FROM "timezoneSnapshot")) > 0) AND ((("scheduledStartAt" AT TIME ZONE "timezoneSnapshot"))::date = "attendanceDate"))))
"Attendance".Attendance_times_valid: CHECK (((("checkOutAt" IS NULL) OR (("checkInAt" IS NOT NULL) AND ("checkOutAt" >= "checkInAt"))) AND ("lateMinutes" >= 0) AND ("workedMinutes" >= 0)))
"EmployeeShift".EmployeeShift_dates_valid: CHECK ((("endDate" IS NULL) OR ("endDate" >= "startDate")))
"EmployeeShift".EmployeeShift_no_overlapping_dates: EXCLUDE USING gist ("employeeId" WITH =, daterange("startDate", "endDate", '[]'::text) WITH &&)
"Leave".Leave_dates_valid: CHECK (("endDate" >= "startDate"))
"Office".Office_location_valid: CHECK ((((latitude >= ('-90'::integer)::double precision) AND (latitude <= (90)::double precision)) AND ((longitude >= ('-180'::integer)::double precision) AND (longitude <= (180)::double precision)) AND ("geofenceRadiusMeters" > 0) AND ("maximumGpsAccuracyMeters" > 0)))
"Office".Office_weekend_days_valid: CHECK ((("weekendDays" IS NOT NULL) AND (COALESCE(array_ndims("weekendDays"), 1) = 1) AND ("weekendDays" <@ ARRAY[0, 1, 2, 3, 4, 5, 6]) AND (array_position("weekendDays", NULL::integer) IS NULL) AND (cardinality("weekendDays") <= 7)))
"RateLimit".RateLimit_count_valid: CHECK ((count >= 0))
"Shift".Shift_policy_valid: CHECK (((("startMinute" >= 0) AND ("startMinute" <= 1439)) AND (("endMinute" >= 0) AND ("endMinute" <= 1439)) AND ("startMinute" <> "endMinute") AND ("graceMinutes" >= 0) AND ("halfDayThreshold" > 0)))
"User".User_email_normalized: CHECK ((email = lower(TRIM(BOTH FROM email))))
"WebAuthnChallenge".WebAuthnChallenge_times_valid: CHECK ((("expiresAt" > "createdAt") AND (("usedAt" IS NULL) OR (("usedAt" >= "createdAt") AND ("usedAt" < "expiresAt")))))
"WebAuthnCredential".Credential_counter_valid: CHECK ((counter >= 0))
Disposable PostgreSQL cluster stopped. Temporary files retained for inspection.
```
