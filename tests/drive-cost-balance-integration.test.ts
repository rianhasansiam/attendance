import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  addDriveCostBalance,
  getDriveCostBalance,
} from "@/modules/drive-costs/balance";
import { updateDriveCostPaymentStatus } from "@/modules/drive-costs/payment-status";
import {
  removeCatalogRecord,
  saveDriveCost,
} from "@/modules/management/catalog";

const database = process.env.TEST_DATABASE_URL;
const actor = { id: "", role: "SUPER_ADMIN" as const };
const tripInput = {
  date: "2026-09-24",
  destinationFrom: "Balance test office",
  destinationTo: "Warehouse",
  kilometers: 10,
  rateType: "IN_TIME",
};

describe.skipIf(!database)("drive cost balance persistence", () => {
  beforeAll(async () => {
    if (!database || !new URL(database).pathname.includes("test"))
      throw new Error("Balance tests require a disposable test database");
    process.env.DATABASE_URL = database;
    actor.id = (
      await db.user.create({
        data: {
          email: `drive-balance-${randomUUID()}@example.test`,
          role: "SUPER_ADMIN",
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (actor.id) {
      await db.driveCostBalanceAddition.deleteMany({
        where: { createdById: actor.id },
      });
      await db.driveCost.deleteMany({ where: { createdById: actor.id } });
    }
    // Keep the actor referenced by append-only audit history in this disposable DB.
    await db.$disconnect();
  });

  it("deducts existing paid trips, permits negatives, and follows status, cost and deletion changes", async () => {
    const initial = await getDriveCostBalance(actor);
    const initialBalance = new Prisma.Decimal(initial.balance);
    const trip = await saveDriveCost(actor, {
      ...tripInput,
      paymentStatus: "PAID",
    });
    expect((await getDriveCostBalance(actor)).balance).toBe(
      initialBalance.minus(50).toFixed(2),
    );

    await addDriveCostBalance(actor, {
      requestId: randomUUID(),
      amount: "20.00",
      note: "Travel funds",
    });
    const funded = await getDriveCostBalance(actor);
    expect(funded.balance).toBe(initialBalance.minus(30).toFixed(2));
    expect(new Prisma.Decimal(funded.balance).isNegative()).toBe(true);
    expect(funded.totalAdded).toBe(
      new Prisma.Decimal(initial.totalAdded).plus(20).toFixed(2),
    );
    expect(funded.totalPaid).toBe(
      new Prisma.Decimal(initial.totalPaid).plus(50).toFixed(2),
    );

    await updateDriveCostPaymentStatus(actor, trip.id, {
      paymentStatus: "PAID",
    });
    expect((await getDriveCostBalance(actor)).balance).toBe(funded.balance);
    await updateDriveCostPaymentStatus(actor, trip.id, {
      paymentStatus: "UNPAID",
    });
    expect((await getDriveCostBalance(actor)).balance).toBe(
      initialBalance.plus(20).toFixed(2),
    );
    await updateDriveCostPaymentStatus(actor, trip.id, {
      paymentStatus: "PAID",
    });
    await saveDriveCost(actor, { ...tripInput, kilometers: 20 }, trip.id);
    expect((await getDriveCostBalance(actor)).balance).toBe(
      initialBalance.minus(80).toFixed(2),
    );
    await removeCatalogRecord(actor, "drive-costs", trip.id);
    expect((await getDriveCostBalance(actor)).balance).toBe(
      initialBalance.plus(20).toFixed(2),
    );
  });

  it("adds exact cents once when the same request is submitted concurrently or retried", async () => {
    const initial = await getDriveCostBalance(actor);
    const input = {
      requestId: randomUUID(),
      amount: "0.10",
      note: "Concurrent funding",
    };
    const [first, retry] = await Promise.all([
      addDriveCostBalance(actor, input),
      addDriveCostBalance(actor, input),
    ]);
    expect(retry).toEqual(first);
    expect(
      await addDriveCostBalance(actor, { ...input, amount: "0.1" }),
    ).toEqual(first);
    expect(
      await db.driveCostBalanceAddition.count({
        where: { requestId: input.requestId },
      }),
    ).toBe(1);
    expect(
      await db.auditLog.count({
        where: { action: "DRIVE_COST_BALANCE_ADDED", resourceId: first.id },
      }),
    ).toBe(1);
    await addDriveCostBalance(actor, {
      requestId: randomUUID(),
      amount: "0.20",
    });
    const trip = await saveDriveCost(actor, {
      ...tripInput,
      kilometers: 0.01,
      paymentStatus: "PAID",
    });
    expect((await getDriveCostBalance(actor)).balance).toBe(
      new Prisma.Decimal(initial.balance).plus("0.25").toFixed(2),
    );

    for (const changed of [{ amount: "0.11" }, { note: "Different funding" }]) {
      await expect(
        addDriveCostBalance(actor, { ...input, ...changed }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    }
    await expect(
      addDriveCostBalance(
        { id: "different-super-admin", role: "SUPER_ADMIN" },
        input,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await removeCatalogRecord(actor, "drive-costs", trip.id);
  });

  it.each(["ADMIN", "MANAGE_DRIVER", "EMPLOYEE"] as const)(
    "rejects direct funding attempts by %s",
    async (role) => {
      await expect(
        addDriveCostBalance(
          { id: actor.id, role },
          { requestId: randomUUID(), amount: "100" },
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it("allows other drive managers to view the shared balance, but blocks employees", async () => {
    const balance = await getDriveCostBalance(actor);
    for (const role of ["ADMIN", "MANAGE_DRIVER"] as const)
      expect(await getDriveCostBalance({ id: actor.id, role })).toEqual(
        balance,
      );
    await expect(
      getDriveCostBalance({ id: actor.id, role: "EMPLOYEE" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("enforces positive additions in the database too", async () => {
    await expect(
      db.driveCostBalanceAddition.create({
        data: {
          requestId: randomUUID(),
          amount: "-0.01",
          createdById: actor.id,
        },
      }),
    ).rejects.toThrow();
  });
});
