CREATE TYPE "LateApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "Attendance" ADD COLUMN "scheduledStartAt" TIMESTAMP(3);

CREATE TABLE "LateApprovalRequest" (
  "id" TEXT NOT NULL,
  "attendanceId" TEXT NOT NULL,
  "status" "LateApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "checkInAt" TIMESTAMP(3) NOT NULL,
  "scheduledStartAt" TIMESTAMP(3),
  "lateMinutes" INTEGER NOT NULL,
  "reason" VARCHAR(1000) NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewNote" VARCHAR(1000),
  CONSTRAINT "LateApprovalRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LateApprovalRequest_late_positive" CHECK ("lateMinutes" > 0),
  CONSTRAINT "LateApprovalRequest_review_valid" CHECK (
    ("status" = 'PENDING' AND "reviewedById" IS NULL AND "reviewedAt" IS NULL AND "reviewNote" IS NULL)
    OR ("status" <> 'PENDING' AND "reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL)
  ),
  CONSTRAINT "LateApprovalRequest_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "Attendance"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "LateApprovalRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "LateApprovalRequest_attendanceId_key" ON "LateApprovalRequest"("attendanceId");
CREATE INDEX "LateApprovalRequest_status_requestedAt_id_idx" ON "LateApprovalRequest"("status", "requestedAt" DESC, "id" DESC);
CREATE INDEX "LateApprovalRequest_reviewedById_idx" ON "LateApprovalRequest"("reviewedById");

-- Recalculate only where the historical scheduled-end snapshot is known.
-- Same completed-minute and late-offset rule as calculateOvertime. Punches and
-- unknown legacy overtime remain untouched; rerunning the formula is idempotent.
UPDATE "Attendance"
SET "overtimeMinutes" = GREATEST(0,
  FLOOR(EXTRACT(EPOCH FROM ("checkOutAt" - GREATEST("checkInAt", "scheduledEndAt"))) / 60)::INTEGER
  - "lateMinutes")
WHERE "scheduledEndAt" IS NOT NULL
  AND "checkInAt" IS NOT NULL AND "checkOutAt" IS NOT NULL;
