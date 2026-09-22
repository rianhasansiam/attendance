import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  count: vi.fn(),
  departments: vi.fn(),
  departmentCount: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn().mockResolvedValue({ id: "admin", role: "ADMIN" }),
}));
vi.mock("@/lib/db", () => ({
  db: {
    driveCost: { findMany: mocks.findMany, count: mocks.count },
    department: {
      findMany: mocks.departments,
      count: mocks.departmentCount,
    },
  },
}));

import { GET } from "@/app/api/admin/[resource]/route";

function list(query = "", resource = "drive-costs") {
  return GET(
    new Request(
      `https://attendance.example.test/api/admin/${resource}${query}`,
    ),
    { params: Promise.resolve({ resource }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([]);
  mocks.count.mockResolvedValue(0);
  mocks.departments.mockResolvedValue([]);
  mocks.departmentCount.mockResolvedValue(0);
});

describe("drive cost date filtering", () => {
  it("passes inclusive dates and destination search to both the page and total queries", async () => {
    const item = {
      id: "trip-end-date",
      date: new Date("2026-09-21T00:00:00.000Z"),
      destinationFrom: "Dhaka office",
      destinationTo: "Gazipur warehouse",
    };
    mocks.findMany.mockResolvedValue([item]);
    mocks.count.mockResolvedValue(3);

    const response = await list(
      "?from=2026-09-01&to=2026-09-21&q=Dhaka&page=2&pageSize=1",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { items: [{ id: item.id }], total: 3, page: 2, pageSize: 1 },
    });
    const where = {
      OR: [
        { destinationFrom: { contains: "Dhaka", mode: "insensitive" } },
        { destinationTo: { contains: "Dhaka", mode: "insensitive" } },
      ],
      date: {
        gte: new Date("2026-09-01T00:00:00.000Z"),
        lte: new Date("2026-09-21T00:00:00.000Z"),
      },
    };
    expect(mocks.findMany).toHaveBeenCalledWith({
      where,
      orderBy: [{ date: "desc" }, { id: "desc" }],
      take: 1,
      skip: 1,
    });
    expect(mocks.count).toHaveBeenCalledWith({ where });
  });

  it.each([
    [
      "one day",
      "?from=2026-09-21&to=2026-09-21",
      {
        gte: new Date("2026-09-21T00:00:00.000Z"),
        lte: new Date("2026-09-21T00:00:00.000Z"),
      },
    ],
    [
      "from date only",
      "?from=2026-09-21",
      { gte: new Date("2026-09-21T00:00:00.000Z") },
    ],
    [
      "to date only",
      "?to=2026-09-21",
      { lte: new Date("2026-09-21T00:00:00.000Z") },
    ],
  ])("supports %s", async (_label, query, date) => {
    const response = await list(query);

    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { date } }),
    );
    expect(mocks.count).toHaveBeenCalledWith({ where: { date } });
  });

  it("returns all dates with default pagination when no dates are selected", async () => {
    expect((await list()).status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: [{ date: "desc" }, { id: "desc" }],
      take: 25,
      skip: 0,
    });
    expect(mocks.count).toHaveBeenCalledWith({ where: {} });
  });

  it.each([
    "?from=2026-02-30",
    "?to=2026-02-30",
    "?from=2026-9-1",
    "?to=2026-09-21T12:00:00Z",
    "?from=2026-09-21&to=2026-09-20",
  ])(
    "rejects invalid date filters before database access: %s",
    async (query) => {
      const response = await list(query);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: "VALIDATION_ERROR" },
      });
      expect(mocks.findMany).not.toHaveBeenCalled();
      expect(mocks.count).not.toHaveBeenCalled();
    },
  );

  it("preserves the existing pagination schema for other resources", async () => {
    const response = await list("?from=not-a-date&q=Operations", "departments");

    expect(response.status).toBe(200);
    expect(mocks.departments).toHaveBeenCalledWith({
      where: { name: { contains: "Operations", mode: "insensitive" } },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: 25,
      skip: 0,
    });
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});
