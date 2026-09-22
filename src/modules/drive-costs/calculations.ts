import "server-only";
import { Prisma } from "@prisma/client";
import { DRIVE_COST_RATES, type DriveCostRateType } from "./rates";

export { DRIVE_COST_RATES } from "./rates";
export type { DriveCostRateType } from "./rates";

/**
 * Returns canonical fixed-scale decimal strings so database writes never pass
 * through floating-point arithmetic.
 */
export function calculateDriveCost(
  kilometers: number,
  rateType: DriveCostRateType,
  isRoundTrip = false,
) {
  const normalizedKilometers = new Prisma.Decimal(
    kilometers.toString(),
  ).toDecimalPlaces(2);
  const ratePerKilometer = new Prisma.Decimal(DRIVE_COST_RATES[rateType]);

  return {
    kilometers: normalizedKilometers.toFixed(2),
    ratePerKilometer: ratePerKilometer.toFixed(2),
    totalCost: normalizedKilometers
      .mul(ratePerKilometer)
      .mul(isRoundTrip ? 2 : 1)
      .toFixed(2),
  };
}
