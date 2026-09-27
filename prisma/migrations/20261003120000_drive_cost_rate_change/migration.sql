-- Rates are determined by the trip date, including backdated entries.
ALTER TABLE "DriveCost" DROP CONSTRAINT "DriveCost_rate_valid";
ALTER TABLE "DriveCost" DROP CONSTRAINT "DriveCost_total_valid";

-- Recalculate from the original distance to avoid compounding an increase.
-- Paid trips are included so the balance continues to reflect their full cost.
UPDATE "DriveCost"
SET
  "ratePerKilometer" = CASE "rateType"
    WHEN 'IN_TIME' THEN 5.50
    WHEN 'OVER_TIME' THEN 11.00
  END,
  "totalCost" = ROUND(
    "kilometers"
      * CASE "rateType" WHEN 'IN_TIME' THEN 5.50 WHEN 'OVER_TIME' THEN 11.00 END
      * CASE WHEN "isRoundTrip" THEN 2 ELSE 1 END,
    2
  )
WHERE "date" >= DATE '2026-09-26';

ALTER TABLE "DriveCost" ADD CONSTRAINT "DriveCost_rate_valid" CHECK (
  (
    "date" < DATE '2026-09-26'
    AND (
      ("rateType" = 'IN_TIME' AND "ratePerKilometer" = 5.00)
      OR ("rateType" = 'OVER_TIME' AND "ratePerKilometer" = 10.00)
    )
  )
  OR (
    "date" >= DATE '2026-09-26'
    AND (
      ("rateType" = 'IN_TIME' AND "ratePerKilometer" = 5.50)
      OR ("rateType" = 'OVER_TIME' AND "ratePerKilometer" = 11.00)
    )
  )
);

-- Round the complete trip once, including any return distance.
ALTER TABLE "DriveCost" ADD CONSTRAINT "DriveCost_total_valid" CHECK (
  "totalCost" = ROUND(
    "kilometers" * "ratePerKilometer"
      * CASE WHEN "isRoundTrip" THEN 2 ELSE 1 END,
    2
  )
);
