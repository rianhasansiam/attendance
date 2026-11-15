-- Overtime requests apply only to future employee checkouts. Historical punches
-- and stored signed overtime balances are intentionally unchanged.
CREATE TYPE "OvertimeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "OvertimeRequest" (
  "id" TEXT NOT NULL,
  "attendanceId" TEXT NOT NULL,
  "status" "OvertimeRequestStatus" NOT NULL DEFAULT 'PENDING',
  "checkInAt" TIMESTAMP(3) NOT NULL,
  "scheduledEndAt" TIMESTAMP(3) NOT NULL,
  "checkOutAt" TIMESTAMP(3) NOT NULL,
  "requestedMinutes" INTEGER NOT NULL,
  "reason" VARCHAR(1000) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "rejectionReason" VARCHAR(1000),
  CONSTRAINT "OvertimeRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OvertimeRequest_eligible_minutes" CHECK (
    "requestedMinutes" >= 60 AND "checkOutAt" >= "checkInAt"
    AND "requestedMinutes" = FLOOR(EXTRACT(EPOCH FROM
      ("checkOutAt" - GREATEST("checkInAt", "scheduledEndAt"))) / 60)::INTEGER
  ),
  CONSTRAINT "OvertimeRequest_reason_valid" CHECK (char_length(btrim("reason")) BETWEEN 10 AND 1000),
  -- A processed decision retains its timestamp when the reviewer is deleted.
  CONSTRAINT "OvertimeRequest_review_valid" CHECK (
    ("status" = 'PENDING' AND "reviewedById" IS NULL AND "reviewedAt" IS NULL AND "rejectionReason" IS NULL)
    OR ("status" = 'APPROVED' AND "reviewedAt" IS NOT NULL AND "rejectionReason" IS NULL)
    OR ("status" = 'REJECTED' AND "reviewedAt" IS NOT NULL)
  ),
  CONSTRAINT "OvertimeRequest_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "Attendance"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OvertimeRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OvertimeRequest_attendanceId_key" ON "OvertimeRequest"("attendanceId");
CREATE INDEX "OvertimeRequest_status_createdAt_id_idx" ON "OvertimeRequest"("status", "createdAt" DESC, "id" DESC);
CREATE INDEX "OvertimeRequest_createdAt_id_idx" ON "OvertimeRequest"("createdAt" DESC, "id" DESC);
CREATE INDEX "OvertimeRequest_reviewedById_idx" ON "OvertimeRequest"("reviewedById");
