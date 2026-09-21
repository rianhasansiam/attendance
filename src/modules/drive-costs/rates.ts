export const DRIVE_COST_RATES = {
  IN_TIME: "5.00",
  OVER_TIME: "10.00",
} as const;

export type DriveCostRateType = keyof typeof DRIVE_COST_RATES;
