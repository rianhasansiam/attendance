import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
vi.mock("@/modules/audit/service", () => ({ writeAudit: mocks.audit }));

import { updateDriveCostPaymentStatus } from "@/modules/drive-costs/payment-status";
import { saveDriveCost } from "@/modules/management/catalog";
import { driveCostSchema } from "@/modules/management/validation";

const trip = {
  date: "2026-09-24",
  destinationFrom: "Office",
  destinationTo: "Warehouse",
  kilometers: 10,
  rateType: "IN_TIME",
};
const tx = {
  driveCost: {
    findUnique: mocks.findUnique,
    create: mocks.create,
    update: mocks.update,
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation((callback) => callback(tx));
  mocks.findUnique.mockResolvedValue({ id: "trip-1", paymentStatus: "PAID" });
  mocks.update.mockImplementation(({ data }) =>
    Promise.resolve({ id: "trip-1", paymentStatus: "PAID", ...data }),
  );
  mocks.create.mockImplementation(({ data }) =>
    Promise.resolve({ id: "trip-1", paymentStatus: "UNPAID", ...data }),
  );
});

describe("drive cost payment status", () => {
  it.each(["ADMIN", "MANAGE_DRIVER"] as const)(
    "rejects explicit status values from %s on create and update",
    async (role) => {
      for (const paymentStatus of ["PAID", "UNPAID"]) {
        for (const id of [undefined, "trip-1"]) {
          await expect(
            saveDriveCost(
              { id: "actor", role },
              { ...trip, paymentStatus },
              id,
            ),
          ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
        }
      }
      await expect(
        updateDriveCostPaymentStatus({ id: "actor", role }, "trip-1", {
          paymentStatus: "PAID",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
    },
  );

  it.each(["ADMIN", "MANAGE_DRIVER", "SUPER_ADMIN"] as const)(
    "preserves paid status when %s edits only trip details",
    async (role) => {
      const result = await saveDriveCost({ id: "actor", role }, trip, "trip-1");
      expect(result.paymentStatus).toBe("PAID");
      expect(mocks.update.mock.calls[0][0].data).not.toHaveProperty(
        "paymentStatus",
      );
    },
  );

  it.each(["PAID", "UNPAID"] as const)(
    "lets a super admin save %s and audits the status change",
    async (paymentStatus) => {
      const previous = {
        id: "trip-1",
        paymentStatus: paymentStatus === "PAID" ? "UNPAID" : "PAID",
      };
      mocks.findUnique.mockResolvedValue(previous);
      const result = await updateDriveCostPaymentStatus(
        { id: "super-admin", role: "SUPER_ADMIN" },
        "trip-1",
        { paymentStatus },
      );
      expect(result.paymentStatus).toBe(paymentStatus);
      expect(mocks.update).toHaveBeenCalledWith({
        where: { id: "trip-1" },
        data: { paymentStatus },
      });
      expect(mocks.audit).toHaveBeenCalledWith(
        "super-admin",
        "DRIVE_COST_UPDATED",
        "DriveCost",
        "trip-1",
        previous,
        result,
        tx,
      );
    },
  );

  it("allows a super admin to create a paid cost", async () => {
    const result = await saveDriveCost(
      { id: "super-admin", role: "SUPER_ADMIN" },
      { ...trip, paymentStatus: "PAID" },
    );
    expect(result.paymentStatus).toBe("PAID");
  });

  it.each(["paid", "UNPAIN", "PENDING", "", null, true])(
    "rejects invalid payment status %s",
    (paymentStatus) => {
      expect(
        driveCostSchema.safeParse({ ...trip, paymentStatus }).success,
      ).toBe(false);
    },
  );
});
