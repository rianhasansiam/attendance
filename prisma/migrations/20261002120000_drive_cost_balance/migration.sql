CREATE TABLE "DriveCostBalanceAddition" (
  "id" TEXT NOT NULL,
  "requestId" UUID NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "note" VARCHAR(500),
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DriveCostBalanceAddition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DriveCostBalanceAddition_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "DriveCostBalanceAddition_createdById_fkey" FOREIGN KEY ("createdById")
    REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "DriveCostBalanceAddition_requestId_key"
  ON "DriveCostBalanceAddition"("requestId");
CREATE INDEX "DriveCostBalanceAddition_createdById_idx"
  ON "DriveCostBalanceAddition"("createdById");
CREATE INDEX "DriveCost_paymentStatus_date_id_idx"
  ON "DriveCost"("paymentStatus", "date" DESC, "id" DESC);

-- No balance is stored or clamped: the application reads total additions minus
-- every currently paid trip. Existing paid trips therefore count immediately,
-- and edits, deletions, and marking a trip unpaid cannot cause double deductions.
