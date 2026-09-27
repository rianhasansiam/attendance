import { describe, expect, it } from "vitest";
import {
  DRIVE_COST_RATES,
  calculateDriveCost,
} from "@/modules/drive-costs/calculations";
import { driveCostSchema } from "@/modules/management/validation";

const validDriveCost = {
  date: "2026-09-21",
  destinationFrom: "Dhaka office",
  destinationTo: "Gazipur warehouse",
  kilometers: 12.5,
  rateType: "IN_TIME" as const,
};

describe("drive cost calculations", () => {
  it.each([
    ["2026-09-25", "IN_TIME", "5.00", "50.00"],
    ["2026-09-25", "OVER_TIME", "10.00", "100.00"],
    ["2026-09-26", "IN_TIME", "5.50", "55.00"],
    ["2026-09-26", "OVER_TIME", "11.00", "110.00"],
    ["2027-01-01", "IN_TIME", "5.50", "55.00"],
    ["2027-01-01", "OVER_TIME", "11.00", "110.00"],
  ] as const)(
    "uses the trip date %s for the %s rate",
    (date, rateType, ratePerKilometer, totalCost) => {
      expect(calculateDriveCost(10, rateType, date)).toEqual({
        kilometers: "10.00",
        ratePerKilometer,
        totalCost,
      });
    },
  );

  it.each([
    [0.01, "IN_TIME", false, "0.06"],
    [0.01, "IN_TIME", true, "0.11"],
    [1.25, "IN_TIME", false, "6.88"],
    [1.25, "IN_TIME", true, "13.75"],
    [1.25, "OVER_TIME", false, "13.75"],
    [1.25, "OVER_TIME", true, "27.50"],
    [100000, "OVER_TIME", true, "2200000.00"],
  ] as const)(
    "rounds the final total once for %skm %s with round trip %s",
    (kilometers, rateType, isRoundTrip, totalCost) => {
      expect(
        calculateDriveCost(kilometers, rateType, "2026-09-26", isRoundTrip)
          .totalCost,
      ).toBe(totalCost);
    },
  );

  it("uses the fixed in-time and over-time rates", () => {
    expect(DRIVE_COST_RATES).toEqual({
      IN_TIME: "5.00",
      OVER_TIME: "10.00",
    });

    expect(calculateDriveCost(2, "IN_TIME", "2026-09-25")).toEqual({
      kilometers: "2.00",
      ratePerKilometer: "5.00",
      totalCost: "10.00",
    });
    expect(calculateDriveCost(2, "OVER_TIME", "2026-09-25")).toEqual({
      kilometers: "2.00",
      ratePerKilometer: "10.00",
      totalCost: "20.00",
    });
  });

  it("returns normalized fixed-scale decimal strings without losing cents", () => {
    expect(calculateDriveCost(1.25, "IN_TIME", "2026-09-25")).toEqual({
      kilometers: "1.25",
      ratePerKilometer: "5.00",
      totalCost: "6.25",
    });
    expect(calculateDriveCost(1.25, "OVER_TIME", "2026-09-25")).toEqual({
      kilometers: "1.25",
      ratePerKilometer: "10.00",
      totalCost: "12.50",
    });
  });

  it.each([
    ["IN_TIME", "12.50"],
    ["OVER_TIME", "25.00"],
  ] as const)(
    "doubles %s round-trip cost while preserving one-way kilometers",
    (rateType, totalCost) => {
      expect(calculateDriveCost(1.25, rateType, "2026-09-25", true)).toEqual({
        kilometers: "1.25",
        ratePerKilometer: DRIVE_COST_RATES[rateType],
        totalCost,
      });
      expect(calculateDriveCost(1.25, rateType, "2026-09-25", false)).toEqual(
        calculateDriveCost(1.25, rateType, "2026-09-25"),
      );
    },
  );
});

describe("drive cost validation", () => {
  it("trims destinations and preserves the validated calculation inputs", () => {
    expect(
      driveCostSchema.parse({
        ...validDriveCost,
        destinationFrom: "  Dhaka office  ",
        destinationTo: "  Gazipur warehouse  ",
      }),
    ).toEqual({ ...validDriveCost, isRoundTrip: false });
  });

  it("accepts an explicit round-trip flag", () => {
    expect(
      driveCostSchema.parse({ ...validDriveCost, isRoundTrip: true }),
    ).toEqual({ ...validDriveCost, isRoundTrip: true });
  });

  it.each(["true", "false", 1, 2, null])(
    "rejects a non-boolean trip flag %s",
    (isRoundTrip) => {
      expect(
        driveCostSchema.safeParse({ ...validDriveCost, isRoundTrip }).success,
      ).toBe(false);
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid kilometer value %s",
    (kilometers) => {
      expect(
        driveCostSchema.safeParse({ ...validDriveCost, kilometers }).success,
      ).toBe(false);
    },
  );

  it("rejects kilometer values with more than two decimal places", () => {
    const result = driveCostSchema.safeParse({
      ...validDriveCost,
      kilometers: 1.234,
    });

    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["kilometers"],
            message: "Kilometers can have at most two decimal places.",
          }),
        ]),
      );
  });

  it("rejects distances above the supported maximum", () => {
    expect(
      driveCostSchema.safeParse({
        ...validDriveCost,
        kilometers: 100000.01,
      }).success,
    ).toBe(false);
  });

  it("rejects blank destinations and invalid calendar dates", () => {
    expect(
      driveCostSchema.safeParse({
        ...validDriveCost,
        date: "2026-02-30",
        destinationFrom: "   ",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown rate type", () => {
    expect(
      driveCostSchema.safeParse({
        ...validDriveCost,
        rateType: "WEEKEND",
      }).success,
    ).toBe(false);
  });

  it("rejects client-controlled rate and total fields", () => {
    const result = driveCostSchema.safeParse({
      ...validDriveCost,
      ratePerKilometer: "0.01",
      totalCost: "0.01",
    });

    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "unrecognized_keys" }),
        ]),
      );
  });
});
