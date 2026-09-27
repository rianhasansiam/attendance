export const DRIVE_COST_RATES = {
  IN_TIME: "5.00",
  OVER_TIME: "10.00",
} as const;

export type DriveCostRateType = keyof typeof DRIVE_COST_RATES;

export const DRIVE_COST_RATE_CHANGE_DATE = "2026-09-26";

const UPDATED_DRIVE_COST_RATES = {
  IN_TIME: "5.50",
  OVER_TIME: "11.00",
} as const;

/** Use the trip's validated calendar date, never the date it is entered or edited. */
export function getDriveCostRates(date: string) {
  return date >= DRIVE_COST_RATE_CHANGE_DATE
    ? UPDATED_DRIVE_COST_RATES
    : DRIVE_COST_RATES;
}
