import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  requireAdmin: vi.fn(),
  rateLimit: vi.fn(),
  createPdf: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: { driveCost: { findMany: mocks.findMany } },
}));
vi.mock("@/lib/auth", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/security", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/modules/reports/pdf", () => ({ createReportPdf: mocks.createPdf }));

import { GET } from "@/app/api/admin/drive-costs/report/route";
import { DomainError } from "@/lib/errors";

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
function trip(
  overrides: Partial<{
    date: Date;
    destinationFrom: string;
    destinationTo: string;
    kilometers: Prisma.Decimal;
    isRoundTrip: boolean;
    rateType: "IN_TIME" | "OVER_TIME";
    ratePerKilometer: Prisma.Decimal;
    totalCost: Prisma.Decimal;
  }> = {},
) {
  return {
    date: day("2026-09-21"),
    destinationFrom: "Dhaka office",
    destinationTo: "Gazipur warehouse",
    kilometers: new Prisma.Decimal("12.34"),
    isRoundTrip: false,
    rateType: "IN_TIME" as const,
    ratePerKilometer: new Prisma.Decimal("5.00"),
    totalCost: new Prisma.Decimal("61.70"),
    ...overrides,
  };
}
function report(query = "") {
  return GET(
    new Request(
      `https://attendance.example.test/api/admin/drive-costs/report${query}`,
    ),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAdmin.mockResolvedValue({ id: "admin", role: "ADMIN" });
  mocks.findMany.mockResolvedValue([]);
  mocks.createPdf.mockResolvedValue(new TextEncoder().encode("%PDF-1.7\n"));
});

describe("drive cost PDF reports", () => {
  it("exports every matching trip with inclusive dates and destination search, ignoring list pagination", async () => {
    const rows = Array.from({ length: 60 }, (_, index) =>
      trip({ destinationTo: `Destination ${index + 1}` }),
    );
    mocks.findMany.mockResolvedValue(rows);

    const response = await report(
      "?from=2026-09-01&to=2026-09-21&q=%20Dhaka%20&page=2&pageSize=1",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="drive-cost-2026-09-01-2026-09-21.pdf"',
    );
    expect(await response.text()).toBe("%PDF-1.7\n");
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      "drive-cost-reports:admin",
      30,
      60,
    );
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { destinationFrom: { contains: "Dhaka", mode: "insensitive" } },
          { destinationTo: { contains: "Dhaka", mode: "insensitive" } },
        ],
        date: { gte: day("2026-09-01"), lte: day("2026-09-21") },
      },
      select: {
        date: true,
        destinationFrom: true,
        destinationTo: true,
        kilometers: true,
        isRoundTrip: true,
        rateType: true,
        ratePerKilometer: true,
        totalCost: true,
      },
      orderBy: [{ date: "desc" }, { id: "desc" }],
      take: 10001,
    });
    const content = mocks.createPdf.mock.calls[0][0];
    expect(content.subtitle).toEqual([
      "Period: 2026-09-01 to 2026-09-21 (inclusive)",
      "Destination search: Dhaka",
    ]);
    expect(content.rows).toHaveLength(60);
    expect(content.rows.at(-1)).toEqual([
      "2026-09-21",
      "Dhaka office",
      "Destination 60",
      "One way",
      "In-time",
      "12.34",
      "5.00",
      "61.70",
    ]);
    expect(content.summary).toContainEqual({
      label: "Total trips",
      value: "60",
    });
  });

  it("preserves exact decimal totals and saved rates for each rate type", async () => {
    mocks.findMany.mockResolvedValue([
      trip(),
      trip({
        kilometers: new Prisma.Decimal("0.01"),
        rateType: "OVER_TIME",
        ratePerKilometer: new Prisma.Decimal("10.00"),
        totalCost: new Prisma.Decimal("0.10"),
      }),
      trip({
        kilometers: new Prisma.Decimal("0.02"),
        ratePerKilometer: new Prisma.Decimal("4.50"),
        totalCost: new Prisma.Decimal("0.09"),
      }),
    ]);

    expect((await report()).status).toBe(200);
    const content = mocks.createPdf.mock.calls[0][0];
    expect(content.summary).toEqual([
      { label: "Total trips", value: "3" },
      { label: "Total kilometers", value: "12.37" },
      { label: "Total cost (BDT)", value: "61.89" },
      { label: "In-time cost (BDT)", value: "61.79" },
      { label: "Overtime cost (BDT)", value: "0.10" },
    ]);
    expect(content.rows[1].slice(3)).toEqual([
      "One way",
      "Overtime",
      "0.01",
      "10.00",
      "0.10",
    ]);
    expect(content.rows[2].slice(5)).toEqual(["0.02", "4.50", "0.09"]);
  });

  it("includes both legs in round-trip distances and sums each saved cost once", async () => {
    mocks.findMany.mockResolvedValue([
      trip(),
      trip({
        kilometers: new Prisma.Decimal("3.21"),
        isRoundTrip: true,
        totalCost: new Prisma.Decimal("32.10"),
      }),
      trip({
        kilometers: new Prisma.Decimal("0.03"),
        isRoundTrip: true,
        rateType: "OVER_TIME",
        ratePerKilometer: new Prisma.Decimal("10.00"),
        totalCost: new Prisma.Decimal("0.60"),
      }),
    ]);

    expect((await report()).status).toBe(200);
    const content = mocks.createPdf.mock.calls[0][0];
    expect(content.summary).toEqual([
      { label: "Total trips", value: "3" },
      { label: "Total kilometers", value: "18.82" },
      { label: "Total cost (BDT)", value: "94.40" },
      { label: "In-time cost (BDT)", value: "93.80" },
      { label: "Overtime cost (BDT)", value: "0.60" },
    ]);
    expect(content.rows.map((row: string[]) => row.slice(3))).toEqual([
      ["One way", "In-time", "12.34", "5.00", "61.70"],
      ["Round trip (×2)", "In-time", "6.42", "5.00", "32.10"],
      ["Round trip (×2)", "Overtime", "0.06", "10.00", "0.60"],
    ]);
  });

  it("keeps legacy trips without a round-trip flag as one-way journeys", async () => {
    mocks.findMany.mockResolvedValue([trip({ isRoundTrip: undefined })]);

    expect((await report()).status).toBe(200);
    const content = mocks.createPdf.mock.calls[0][0];
    expect(content.rows[0].slice(3)).toEqual([
      "One way",
      "In-time",
      "12.34",
      "5.00",
      "61.70",
    ]);
    expect(content.summary).toContainEqual({
      label: "Total kilometers",
      value: "12.34",
    });
    expect(content.summary).toContainEqual({
      label: "Total cost (BDT)",
      value: "61.70",
    });
  });

  it("keeps cents exact for large reports without floating-point accumulation", async () => {
    mocks.findMany.mockResolvedValue(
      Array.from({ length: 1000 }, () =>
        trip({ totalCost: new Prisma.Decimal("9999999999.99") }),
      ),
    );

    expect((await report()).status).toBe(200);
    expect(mocks.createPdf.mock.calls[0][0].summary).toContainEqual({
      label: "Total cost (BDT)",
      value: "9999999999990.00",
    });
  });

  it.each([
    [
      "same day",
      "?from=2026-09-21&to=2026-09-21",
      { gte: day("2026-09-21"), lte: day("2026-09-21") },
      "Date: 2026-09-21",
      "2026-09-21",
    ],
    [
      "from only",
      "?from=2026-09-21",
      { gte: day("2026-09-21") },
      "From: 2026-09-21 onward",
      "from-2026-09-21",
    ],
    [
      "to only",
      "?to=2026-09-21",
      { lte: day("2026-09-21") },
      "Through: 2026-09-21 (inclusive)",
      "through-2026-09-21",
    ],
  ])("supports %s filters", async (_name, query, date, subtitle, filename) => {
    const response = await report(query);

    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { date } }),
    );
    expect(mocks.createPdf.mock.calls[0][0].subtitle).toEqual([subtitle]);
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="drive-cost-${filename}.pdf"`,
    );
  });

  it("creates a valid empty report with zero totals when no trips match", async () => {
    const response = await report();

    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="drive-cost-all-dates.pdf"',
    );
    expect(mocks.createPdf).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Drive cost report",
        subtitle: ["Period: All dates"],
        rows: [],
        summary: [
          { label: "Total trips", value: "0" },
          { label: "Total kilometers", value: "0.00" },
          { label: "Total cost (BDT)", value: "0.00" },
          { label: "In-time cost (BDT)", value: "0.00" },
          { label: "Overtime cost (BDT)", value: "0.00" },
        ],
      }),
    );
  });

  it.each([
    "?from=2026-02-30",
    "?to=2026-02-30",
    "?from=2026-9-1",
    "?from=2026-09-22&to=2026-09-21",
  ])("rejects invalid dates before database access: %s", async (query) => {
    const response = await report(query);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.createPdf).not.toHaveBeenCalled();
  });

  it.each([
    ["UNAUTHENTICATED", 401],
    ["FORBIDDEN", 403],
  ])("requires administrator access: %s", async (code, status) => {
    mocks.requireAdmin.mockRejectedValue(
      new DomainError(code, "Denied", status),
    );

    const response = await report();

    expect(response.status).toBe(status);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.createPdf).not.toHaveBeenCalled();
  });

  it("rejects oversized results instead of producing an incomplete PDF", async () => {
    mocks.findMany.mockResolvedValue(
      Array.from({ length: 10001 }, () => trip()),
    );

    const response = await report();

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "REPORT_TOO_LARGE" },
    });
    expect(mocks.createPdf).not.toHaveBeenCalled();
  });
});
