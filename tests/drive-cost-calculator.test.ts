import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  requireDriveCostManager: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: { driveCost: { findMany: mocks.findMany } },
}));
vi.mock("@/lib/auth", () => ({
  requireDriveCostManager: mocks.requireDriveCostManager,
}));

import { GET } from "@/app/api/admin/drive-costs/calculate/route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireDriveCostManager.mockResolvedValue({
    id: "admin",
    role: "ADMIN",
  });
  mocks.findMany.mockResolvedValue([]);
});

const calculate = (query = "") =>
  GET(
    new Request(
      `https://attendance.example.test/api/admin/drive-costs/calculate?from=2026-09-21${query}`,
    ),
  );

describe("drive cost calculator", () => {
  it("counts both legs for round trips and sums saved costs once in each rate group", async () => {
    mocks.findMany.mockResolvedValue([
      {
        kilometers: new Prisma.Decimal("12.50"),
        rateType: "IN_TIME",
        isRoundTrip: true,
        totalCost: new Prisma.Decimal("125.00"),
      },
      {
        kilometers: new Prisma.Decimal("1.25"),
        rateType: "IN_TIME",
        isRoundTrip: false,
        totalCost: new Prisma.Decimal("6.25"),
      },
      {
        kilometers: new Prisma.Decimal("0.01"),
        rateType: "OVER_TIME",
        isRoundTrip: true,
        totalCost: new Prisma.Decimal("0.20"),
      },
      {
        kilometers: new Prisma.Decimal("0.02"),
        rateType: "OVER_TIME",
        totalCost: new Prisma.Decimal("0.20"),
      },
    ]);
    const response = await calculate();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        paymentStatus: null,
        totalRecords: 4,
        totalKilometers: "26.29",
        totalCost: "131.65",
        breakdown: {
          inTime: { records: 2, kilometers: "26.25", totalCost: "131.25" },
          overTime: { records: 2, kilometers: "0.04", totalCost: "0.40" },
        },
        records: [
          { kilometers: "12.5", isRoundTrip: true },
          { kilometers: "1.25", isRoundTrip: false },
          { kilometers: "0.01", isRoundTrip: true },
          { kilometers: "0.02" },
        ],
      },
    });
  });

  it("returns zero totals for an empty day", async () => {
    const response = await calculate();
    expect(await response.json()).toMatchObject({
      data: {
        totalRecords: 0,
        totalKilometers: "0.00",
        totalCost: "0.00",
        breakdown: {
          inTime: { records: 0, kilometers: "0.00", totalCost: "0.00" },
          overTime: { records: 0, kilometers: "0.00", totalCost: "0.00" },
        },
      },
    });
  });

  it.each([
    ["PAID", "25.00", "125.00", "0.00"],
    ["UNPAID", "1.25", "0.00", "12.50"],
  ])(
    "calculates totals and returns only %s trips for the selected date range",
    async (paymentStatus, kilometers, inTimeCost, overTimeCost) => {
      const records = [
        {
          paymentStatus: "PAID",
          kilometers: new Prisma.Decimal("12.50"),
          isRoundTrip: true,
          rateType: "IN_TIME",
          totalCost: new Prisma.Decimal("125.00"),
        },
        {
          paymentStatus: "UNPAID",
          kilometers: new Prisma.Decimal("1.25"),
          isRoundTrip: false,
          rateType: "OVER_TIME",
          totalCost: new Prisma.Decimal("12.50"),
        },
      ];
      mocks.findMany.mockImplementation(async ({ where }) =>
        records.filter(
          (record) => record.paymentStatus === where.paymentStatus,
        ),
      );

      const response = await calculate(
        `&to=2026-09-22&paymentStatus=${paymentStatus}`,
      );

      expect(response.status).toBe(200);
      expect(mocks.findMany).toHaveBeenCalledWith({
        where: {
          paymentStatus,
          date: {
            gte: new Date("2026-09-21T00:00:00.000Z"),
            lte: new Date("2026-09-22T00:00:00.000Z"),
          },
        },
        orderBy: [{ date: "asc" }, { id: "asc" }],
      });
      expect(await response.json()).toMatchObject({
        data: {
          dateFrom: "2026-09-21",
          dateTo: "2026-09-22",
          isSingleDay: false,
          paymentStatus,
          totalRecords: 1,
          totalKilometers: kilometers,
          totalCost: new Prisma.Decimal(inTimeCost)
            .add(overTimeCost)
            .toFixed(2),
          breakdown: {
            inTime: { totalCost: inTimeCost },
            overTime: { totalCost: overTimeCost },
          },
          records: [{ paymentStatus }],
        },
      });
    },
  );

  it("treats an empty payment filter as all statuses and returns its applied scope", async () => {
    const response = await calculate("&paymentStatus=");

    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          date: {
            gte: new Date("2026-09-21T00:00:00.000Z"),
            lte: new Date("2026-09-21T00:00:00.000Z"),
          },
        },
      }),
    );
    expect(await response.json()).toMatchObject({
      data: { paymentStatus: null },
    });
  });

  it("rejects invalid payment filters before querying trips", async () => {
    const response = await calculate("&paymentStatus=PENDING");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});
