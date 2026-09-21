-- REVIEWED PROPOSAL, NOT INSTALLED IN prisma/migrations.
-- Target: all three existing repository migrations applied.
-- Assumption: every old timestamp WITHOUT time zone stores UTC clock values.
-- Quiesce application writers for this coordinated maintenance deployment.
-- This file and constraints.sql must run in ONE migration transaction:
-- BEGIN; [this file] [constraints.sql] COMMIT;
-- For a large deployment split into expand/backfill/contract and build ordinary
-- indexes CONCURRENTLY outside a transaction; do not deploy the old client after contract.
-- Preflight: unknown event types, orphan leave reviewers, invalid GPS/policies,
-- and overlapping assignments. Fail on bad data; never silently discard it.
-- Historical snapshots intentionally remain NULL unless established from evidence.

-- CreateEnum
CREATE TYPE "AttendanceEventType" AS ENUM ('CHECK_IN_SUCCESS', 'CHECK_OUT_SUCCESS', 'CHECK_IN_REJECTED', 'CHECK_OUT_REJECTED', 'LATE_REASON_SUBMITTED', 'LATE_REASON_REJECTED', 'DEVICE_REGISTERED', 'DEVICE_APPROVED', 'DEVICE_APPROVAL_REMOVED', 'DEVICE_REVOKED', 'ADMIN_CORRECTION');

-- DropIndex
DROP INDEX "WebAuthnChallenge_employeeId_purpose_idx";

-- DropIndex
DROP INDEX "AttendanceEvent_employeeId_createdAt_idx";

-- DropIndex
DROP INDEX "AttendanceEvent_type_createdAt_idx";

-- DropIndex
DROP INDEX "Leave_status_idx";

-- DropIndex
DROP INDEX "AuditLog_createdAt_idx";

-- DropIndex
DROP INDEX "AuditLog_resource_resourceId_idx";

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "emailVerified" SET DATA TYPE TIMESTAMPTZ(3) USING "emailVerified" AT TIME ZONE 'UTC',
ALTER COLUMN "lastLoginAt" SET DATA TYPE TIMESTAMPTZ(3) USING "lastLoginAt" AT TIME ZONE 'UTC',
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "Session" ALTER COLUMN "expires" SET DATA TYPE TIMESTAMPTZ(3) USING "expires" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "Employee" ALTER COLUMN "joinedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "joinedAt" AT TIME ZONE 'UTC',
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "Department" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "Office" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "OfficeNetwork" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

-- AlterTable
-- Preserve valid existing HH:mm values before removing the old representation.
ALTER TABLE "Shift" ADD COLUMN "startMinute" INTEGER, ADD COLUMN "endMinute" INTEGER;
UPDATE "Shift" SET
  "startMinute" = split_part("startTime", ':', 1)::integer * 60 + split_part("startTime", ':', 2)::integer,
  "endMinute" = split_part("endTime", ':', 1)::integer * 60 + split_part("endTime", ':', 2)::integer;
ALTER TABLE "Shift" DROP CONSTRAINT "Shift_policy_valid";
ALTER TABLE "Shift" ALTER COLUMN "startMinute" SET NOT NULL,
ALTER COLUMN "endMinute" SET NOT NULL,
DROP COLUMN "startTime",
DROP COLUMN "endTime",
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "EmployeeShift" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "WebAuthnCredential" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
ALTER COLUMN "revokedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "revokedAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "WebAuthnChallenge" ALTER COLUMN "expiresAt" SET DATA TYPE TIMESTAMPTZ(3) USING "expiresAt" AT TIME ZONE 'UTC',
ALTER COLUMN "usedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "usedAt" AT TIME ZONE 'UTC',
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN     "graceMinutesSnapshot" INTEGER,
ADD COLUMN     "halfDayThresholdSnapshot" INTEGER,
ADD COLUMN     "scheduledEndAt" TIMESTAMPTZ(3),
ADD COLUMN     "scheduledStartAt" TIMESTAMPTZ(3),
ADD COLUMN     "timezoneSnapshot" TEXT,
ALTER COLUMN "checkInAt" SET DATA TYPE TIMESTAMPTZ(3) USING "checkInAt" AT TIME ZONE 'UTC',
ALTER COLUMN "checkOutAt" SET DATA TYPE TIMESTAMPTZ(3) USING "checkOutAt" AT TIME ZONE 'UTC',
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

-- AlterTable
-- ALTER TYPE preserves history and does not fire the row UPDATE/DELETE triggers.
-- Unknown legacy values fail the cast; audit/migrate them deliberately first.
ALTER TABLE "AttendanceEvent" ALTER COLUMN "type" TYPE "AttendanceEventType"
USING "type"::"AttendanceEventType",
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "Holiday" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "Leave" ALTER COLUMN "reviewedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "reviewedAt" AT TIME ZONE 'UTC',
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "AuditLog" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "RateLimit" ALTER COLUMN "resetAt" SET DATA TYPE TIMESTAMPTZ(3) USING "resetAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "SystemSetting" ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

-- CreateIndex
CREATE INDEX "User_status_role_idx" ON "User"("status", "role");

-- CreateIndex
CREATE INDEX "WebAuthnChallenge_context_idx" ON "WebAuthnChallenge"("employeeId", "purpose", "sessionId", "usedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "AttendanceEvent_attendanceId_createdAt_id_idx" ON "AttendanceEvent"("attendanceId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "AttendanceEvent_employeeId_createdAt_id_idx" ON "AttendanceEvent"("employeeId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "AttendanceEvent_type_createdAt_id_idx" ON "AttendanceEvent"("type", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "AttendanceEvent_createdAt_id_idx" ON "AttendanceEvent"("createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Leave_status_createdAt_id_idx" ON "Leave"("status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_id_idx" ON "AuditLog"("createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_id_idx" ON "AuditLog"("actorId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_resource_resourceId_createdAt_id_idx" ON "AuditLog"("resource", "resourceId", "createdAt" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "Leave" ADD CONSTRAINT "Leave_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
