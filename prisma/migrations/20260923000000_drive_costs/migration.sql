-- CreateEnum
CREATE TYPE "DriveCostRateType" AS ENUM ('IN_TIME', 'OVER_TIME');

-- CreateTable
CREATE TABLE "DriveCost" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "destinationFrom" VARCHAR(160) NOT NULL,
    "destinationTo" VARCHAR(160) NOT NULL,
    "kilometers" DECIMAL(10,2) NOT NULL,
    "rateType" "DriveCostRateType" NOT NULL,
    "ratePerKilometer" DECIMAL(10,2) NOT NULL,
    "totalCost" DECIMAL(12,2) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriveCost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DriveCost_date_id_idx" ON "DriveCost"("date" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "DriveCost_createdById_date_idx" ON "DriveCost"("createdById", "date" DESC);

-- AddForeignKey
ALTER TABLE "DriveCost" ADD CONSTRAINT "DriveCost_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Keep persisted calculations internally consistent even outside the app.
ALTER TABLE "DriveCost" ADD CONSTRAINT "DriveCost_destinations_valid" CHECK (
  "destinationFrom" = btrim("destinationFrom")
  AND "destinationTo" = btrim("destinationTo")
  AND char_length("destinationFrom") BETWEEN 1 AND 160
  AND char_length("destinationTo") BETWEEN 1 AND 160
);
ALTER TABLE "DriveCost" ADD CONSTRAINT "DriveCost_kilometers_valid" CHECK (
  "kilometers" > 0 AND "kilometers" <= 100000
);
ALTER TABLE "DriveCost" ADD CONSTRAINT "DriveCost_rate_valid" CHECK (
  ("rateType" = 'IN_TIME' AND "ratePerKilometer" = 5.00)
  OR ("rateType" = 'OVER_TIME' AND "ratePerKilometer" = 10.00)
);
ALTER TABLE "DriveCost" ADD CONSTRAINT "DriveCost_total_valid" CHECK (
  "totalCost" = "kilometers" * "ratePerKilometer"
);
