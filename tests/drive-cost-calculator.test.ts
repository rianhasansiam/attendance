import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  requireAdmin: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: { driveCost: { findMany: mocks.findMany } },
}));
vi.mock("@/lib/auth", () => ({ requireAdmin: mocks.requireAdmin }));

import { GET } from "@/app/api/admin/drive-costs/calculate/route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAdmin.mockResolvedValue({ id: "admin", role: "ADMIN" });
  mocks.findMany.mockResolvedValue([]);
});

const calculate = () =>
  GET(
    new Request(
      "https://attendance.example.test/api/admin/drive-costs/calculate?from=2026-09-21",
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
});
