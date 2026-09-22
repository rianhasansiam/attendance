-- Existing trips keep their one-way distance and cost.
ALTER TABLE "DriveCost" ADD COLUMN "isRoundTrip" BOOLEAN NOT NULL DEFAULT false;

-- Kilometers is the entered one-way distance; a return trip covers it twice.
ALTER TABLE "DriveCost" DROP CONSTRAINT "DriveCost_total_valid";
ALTER TABLE "DriveCost" ADD CONSTRAINT "DriveCost_total_valid" CHECK (
  "totalCost" = "kilometers" * "ratePerKilometer"
    * CASE WHEN "isRoundTrip" THEN 2 ELSE 1 END
);
