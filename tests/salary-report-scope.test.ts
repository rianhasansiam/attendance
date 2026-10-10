import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attendance: vi.fn(),
  employees: vi.fn(),
  holidays: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    attendance: { findMany: mocks.attendance },
    employee: { findMany: mocks.employees },
    holiday: { findMany: mocks.holidays },
  },
}));
import { reportRecords } from "@/modules/reports/service";

const actor = { id: "super-admin", role: "SUPER_ADMIN" } as const;
const filters = {
  from: "2026-10-01",
  to: "2026-10-31",
  format: "json",
  page: 1,
  pageSize: 100,
} as const;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.attendance.mockResolvedValue([]);
  mocks.employees.mockResolvedValue([]);
  mocks.holidays.mockResolvedValue([]);
});

describe("bounded salary scope in the authoritative attendance report", () => {
  it("limits both attendance and derived schedules in one bulk query per source", async () => {
    await reportRecords(actor, filters, new Date("2026-10-10T05:00:00Z"), [
      "employee-1",
      "employee-2",
    ]);
    expect(mocks.attendance).toHaveBeenCalledOnce();
    expect(mocks.employees).toHaveBeenCalledOnce();
    expect(mocks.attendance).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [{ employeeId: { in: ["employee-1", "employee-2"] } }],
        }),
      }),
    );
    expect(mocks.employees).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [{ id: { in: ["employee-1", "employee-2"] } }],
        }),
      }),
    );
  });
  it("intersects employee scope with existing office, department and single-employee filters", async () => {
    await reportRecords(
      actor,
      {
        ...filters,
        employeeId: "employee-1",
        officeId: "office-1",
        departmentId: "department-1",
      },
      new Date("2026-10-10T05:00:00Z"),
      ["employee-2"],
    );
    expect(mocks.attendance).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          employeeId: "employee-1",
          officeId: "office-1",
          employee: { departmentId: "department-1" },
          AND: [{ employeeId: { in: ["employee-2"] } }],
        }),
      }),
    );
    expect(mocks.employees).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "employee-1",
          officeId: "office-1",
          departmentId: "department-1",
          AND: [{ id: { in: ["employee-2"] } }],
        }),
      }),
    );
  });
  it("retains report authorization before querying any bounded data", async () => {
    await expect(
      reportRecords({ id: "employee", role: "EMPLOYEE" }, filters, new Date(), [
        "employee-1",
      ]),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(mocks.attendance).not.toHaveBeenCalled();
    expect(mocks.employees).not.toHaveBeenCalled();
  });
});
