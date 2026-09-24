import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  cache: vi.fn(),
  transaction: vi.fn(),
  updateLeave: vi.fn(),
}));
vi.mock("next/cache", () => ({
  cacheLife: mocks.cache,
  cacheTag: mocks.cache,
  revalidateTag: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    employee: { findUnique: mocks.read, count: mocks.read },
    department: { findMany: mocks.read, count: mocks.read },
    driveCost: { findMany: mocks.read },
    systemSetting: { findUnique: mocks.read },
    leave: { updateMany: mocks.updateLeave },
    $transaction: mocks.transaction,
  },
}));

import { getOwnEmployeeProfile } from "@/modules/employees/service";
import { listLookupOptions } from "@/modules/management/lookups";
import {
  getAdminDashboard,
  getReport,
  reportRecords,
} from "@/modules/reports/service";
import { getDriveCostReport } from "@/modules/drive-costs/report";
import {
  getOfficePolicyDefaults,
  saveDepartment,
  saveOffice,
  saveNetwork,
  saveShift,
  saveAssignment,
  saveHoliday,
  saveDriveCost,
  removeCatalogRecord,
} from "@/modules/management/catalog";
import {
  createLeave,
  cancelLeave,
  reviewLeave,
  updateDevice,
} from "@/modules/management/workflows";

beforeEach(() => vi.resetAllMocks());
const query = { page: 1, pageSize: 100 };
const filters = {
  ...query,
  from: "2026-09-01",
  to: "2026-09-24",
  format: "json" as const,
};

describe("server entry point authorization", () => {
  it.each(["EMPLOYEE", "MANAGE_DRIVER"] as const)(
    "rejects %s before either data or shared cache access",
    async (role) => {
      const actor = { id: "actor", role };
      const operations = [
        () => listLookupOptions(actor, "departments", query),
        () => getAdminDashboard(actor),
        () => getReport(actor, filters),
        () => reportRecords(actor, filters),
        () => getOfficePolicyDefaults(actor),
        ...[
          saveDepartment,
          saveOffice,
          saveNetwork,
          saveShift,
          saveAssignment,
          saveHoliday,
        ].map((save) => () => save(actor, {})),
        () => removeCatalogRecord(actor, "offices", "id"),
        () => reviewLeave(actor, "id", { status: "APPROVED" }),
        () => updateDevice(actor, "id", { approved: true }),
      ];
      for (const operation of operations)
        await expect(operation()).rejects.toMatchObject({
          code: "FORBIDDEN",
          status: 403,
        });
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.cache).not.toHaveBeenCalled();
      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );

  it("rejects ordinary employees from shared drive-cost reads and writes", async () => {
    const actor = { id: "employee", role: "EMPLOYEE" } as const;
    await expect(getDriveCostReport(actor, {})).rejects.toMatchObject({
      status: 403,
    });
    await expect(saveDriveCost(actor, {})).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      removeCatalogRecord(actor, "drive-costs", "id"),
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("allows administrators without Employee profiles to read reference display data", async () => {
    mocks.read
      .mockResolvedValueOnce([{ id: "department", name: "Operations" }])
      .mockResolvedValueOnce(1);
    await expect(
      listLookupOptions({ id: "admin", role: "ADMIN" }, "departments", query),
    ).resolves.toMatchObject({ items: [{ id: "department" }], total: 1 });
  });

  it("rejects absent employee profiles before a profile read", async () => {
    await expect(
      getOwnEmployeeProfile({ id: "admin", employee: null }),
    ).rejects.toMatchObject({ code: "NO_EMPLOYEE", status: 403 });
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("scopes own profile reads to both authenticated identity and employee id", async () => {
    mocks.read.mockResolvedValue({ id: "own-employee" });
    await getOwnEmployeeProfile({
      id: "user",
      employee: { id: "own-employee" },
    });
    expect(mocks.read).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "own-employee", userId: "user" },
      }),
    );
    mocks.read.mockResolvedValue(null);
    await expect(
      getOwnEmployeeProfile({ id: "user", employee: { id: "other-employee" } }),
    ).rejects.toMatchObject({ code: "NO_EMPLOYEE", status: 403 });
  });

  it("denies missing profiles and cross-user leave creation before accessing leave data", async () => {
    const input = {
      startDate: "2026-10-01",
      endDate: "2026-10-02",
      reason: "Planned leave",
    };
    await expect(
      createLeave({ id: "user", employee: null }, input),
    ).rejects.toMatchObject({ code: "NO_EMPLOYEE" });
    await expect(
      cancelLeave({ id: "user", employee: null }, "leave"),
    ).rejects.toMatchObject({ code: "NO_EMPLOYEE" });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.updateLeave).not.toHaveBeenCalled();
    mocks.transaction.mockImplementation((work) =>
      work({ employee: { findUnique: mocks.read } }),
    );
    mocks.read.mockResolvedValue(null);
    await expect(
      createLeave({ id: "user", employee: { id: "other" } }, input),
    ).rejects.toMatchObject({ code: "NO_EMPLOYEE", status: 403 });
    expect(mocks.read).toHaveBeenCalledWith({
      where: { id: "other", userId: "user" },
      select: { id: true },
    });
  });

  it("requires both employee and user ownership when cancelling leave", async () => {
    mocks.updateLeave.mockResolvedValue({ count: 0 });
    await expect(
      cancelLeave({ id: "user", employee: { id: "other" } }, "leave"),
    ).rejects.toMatchObject({ code: "LEAVE_NOT_CANCELLABLE" });
    expect(mocks.updateLeave).toHaveBeenCalledWith({
      where: {
        id: "leave",
        employeeId: "other",
        employee: { userId: "user" },
        status: "PENDING",
      },
      data: { status: "CANCELLED" },
    });
  });
});
