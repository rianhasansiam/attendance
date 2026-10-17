import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  getCompanyMoneyOverview,
  recordCompanyMoneyTransaction,
} from "@/modules/company-money/service";
import { deleteUser } from "@/modules/management/workflows";

const database = process.env.TEST_DATABASE_URL;
const actor = { id: "", role: "SUPER_ADMIN" as const };

describe.skipIf(!database)("company money persistence", () => {
  beforeAll(async () => {
    if (!database || !new URL(database).pathname.includes("test"))
      throw new Error("Company money tests require a disposable test database");
    process.env.DATABASE_URL = database;
    actor.id = (
      await db.user.create({
        data: {
          email: `company-money-${randomUUID()}@example.test`,
          name: "Company money owner",
          role: "SUPER_ADMIN",
        },
      })
    ).id;
  });

  beforeEach(async () => {
    // The ledger is append-only in production. Reset only this disposable test table.
    await db.$executeRawUnsafe(
      'TRUNCATE TABLE "CompanyMoneyTransaction", "CompanyMoneyMutationReceipt"',
    );
  });

  afterAll(async () => {
    if (actor.id)
      await db.$executeRawUnsafe(
        'TRUNCATE TABLE "CompanyMoneyTransaction", "CompanyMoneyMutationReceipt"',
      );
    // Append-only audit history retains its fixture actors in the disposable DB.
    await db.$disconnect();
  });

  function record(
    type: "ADD" | "REMOVE",
    amount: string,
    note?: string,
    date = "2026-10-17",
  ) {
    return recordCompanyMoneyTransaction(actor, {
      requestId: randomUUID(),
      type,
      amount,
      date,
      ...(note === undefined ? {} : { note }),
    });
  }

  it("starts at zero and records exact cents independently of all other ledgers", async () => {
    expect(await getCompanyMoneyOverview(actor)).toMatchObject({
      balance: "0.00",
      totalAdded: "0.00",
      totalRemoved: "0.00",
      items: [],
      total: 0,
    });
    await db.driveCostBalanceAddition.create({
      data: { requestId: randomUUID(), amount: "999", createdById: actor.id },
    });
    await record("ADD", "0.10");
    await record("ADD", "0.20", "Company deposit");
    await record("REMOVE", "0.01", "Company payment");
    expect(await getCompanyMoneyOverview(actor)).toMatchObject({
      balance: "0.29",
      totalAdded: "0.30",
      totalRemoved: "0.01",
      total: 3,
    });
  });

  it("returns paginated history with authors and preserves all-time totals", async () => {
    const first = await record("ADD", "125.50");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await record("REMOVE", "45.25", "Office purchase");
    const overview = await getCompanyMoneyOverview(actor, {
      page: 1,
      pageSize: 1,
    });
    expect(overview).toMatchObject({
      balance: "80.25",
      totalAdded: "125.50",
      totalRemoved: "45.25",
      total: 2,
      page: 1,
      pageSize: 1,
    });
    expect(overview.items).toEqual([second]);
    expect(second.createdBy).toMatchObject({ name: "Company money owner" });
    expect(
      (await getCompanyMoneyOverview(actor, { page: 2, pageSize: 1 })).items,
    ).toEqual([first]);
    expect(
      (await getCompanyMoneyOverview(actor, { page: 3, pageSize: 1 })).items,
    ).toEqual([]);
    expect(
      await getCompanyMoneyOverview({ id: actor.id, role: "ADMIN" }),
    ).toMatchObject({ balance: "80.25", total: 2 });
  });

  it("persists the selected calendar date, sorts history by that date, and audits it", async () => {
    const current = await record("ADD", "10.00", undefined, "2026-10-17");
    const future = await record("ADD", "20.00", undefined, "2050-01-01");
    const past = await record("ADD", "30.00", undefined, "2000-02-29");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const sameDayLater = await record("ADD", "40.00", undefined, "2050-01-01");

    expect((await getCompanyMoneyOverview(actor)).items).toEqual([
      sameDayLater,
      future,
      current,
      past,
    ]);
    expect(
      (await getCompanyMoneyOverview(actor, { page: 2, pageSize: 2 })).items,
    ).toEqual([current, past]);
    expect(
      await db.companyMoneyTransaction.findUniqueOrThrow({
        where: { id: past.id },
      }),
    ).toMatchObject({ date: new Date("2000-02-29T00:00:00.000Z") });
    expect(
      await db.auditLog.findFirstOrThrow({ where: { resourceId: past.id } }),
    ).toMatchObject({ newState: { date: "2000-02-29" } });
  });

  it("blocks an overdraft and permits removing the exact remaining balance", async () => {
    await record("ADD", "10.05");
    await expect(record("REMOVE", "10.06")).rejects.toMatchObject({
      code: "INSUFFICIENT_COMPANY_BALANCE",
      status: 409,
    });
    expect(await db.companyMoneyTransaction.count()).toBe(1);
    await record("REMOVE", "10.05");
    expect((await getCompanyMoneyOverview(actor)).balance).toBe("0.00");
  });

  it("serializes concurrent withdrawals so they cannot overdraw the shared balance", async () => {
    await record("ADD", "10.00");
    const results = await Promise.allSettled([
      record("REMOVE", "7.00"),
      record("REMOVE", "7.00"),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { code: "INSUFFICIENT_COMPANY_BALANCE" } });
    expect((await getCompanyMoneyOverview(actor)).balance).toBe("3.00");
  });

  it("replays concurrent/retried UUIDs once and rejects changed transaction payloads", async () => {
    const input = {
      requestId: randomUUID(),
      type: "ADD",
      amount: "0.10",
      date: "2026-10-17",
      note: "Funding",
    };
    const [first, retry] = await Promise.all([
      recordCompanyMoneyTransaction(actor, input),
      recordCompanyMoneyTransaction(actor, input),
    ]);
    expect(retry).toEqual(first);
    expect(
      await recordCompanyMoneyTransaction(actor, {
        ...input,
        amount: "0.1",
        note: " Funding ",
      }),
    ).toEqual(first);
    expect(await db.companyMoneyTransaction.count()).toBe(1);
    expect(
      await db.auditLog.count({
        where: { resourceId: first.id, action: "COMPANY_MONEY_ADDED" },
      }),
    ).toBe(1);
    for (const changed of [
      { amount: "0.11" },
      { type: "REMOVE" },
      { note: "Different" },
      { date: "2026-10-16" },
    ])
      await expect(
        recordCompanyMoneyTransaction(actor, { ...input, ...changed }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const other = await db.user.create({
      data: { email: `${randomUUID()}@example.test`, role: "SUPER_ADMIN" },
    });
    await expect(
      recordCompanyMoneyTransaction(other, input),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await getCompanyMoneyOverview(actor)).balance).toBe("0.10");
  });

  it.each(["ADMIN", "MANAGE_DRIVER", "EMPLOYEE"] as const)(
    "denies %s writes even when the API is bypassed",
    async (role) => {
      await expect(
        recordCompanyMoneyTransaction(
          { id: actor.id, role },
          {
            requestId: randomUUID(),
            type: "ADD",
            amount: "1",
            date: "2026-10-17",
          },
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it.each(["EMPLOYEE", "MANAGE_DRIVER"] as const)(
    "denies %s reads even when the API is bypassed",
    async (role) => {
      await expect(
        getCompanyMoneyOverview({ id: actor.id, role }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it("rechecks persisted role and status under a lock before writing", async () => {
    const target = await db.user.create({
      data: { email: `${randomUUID()}@example.test`, role: "ADMIN" },
    });
    const staleActor = { id: target.id, role: "SUPER_ADMIN" as const };
    const input = {
      requestId: randomUUID(),
      type: "ADD",
      amount: "1",
      date: "2026-10-17",
    };
    await expect(
      recordCompanyMoneyTransaction(staleActor, input),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db.user.update({
      where: { id: target.id },
      data: { role: "SUPER_ADMIN", status: "INACTIVE" },
    });
    await expect(
      recordCompanyMoneyTransaction(staleActor, input),
    ).rejects.toMatchObject({ code: "USER_INACTIVE" });
    expect(await db.companyMoneyTransaction.count()).toBe(0);
  });

  it("guards direct SQL against invalid amounts, overdrafts, inactive writers and history mutations", async () => {
    for (const amount of ["0", "-0.01", "NaN"])
      await expect(
        db.companyMoneyTransaction.create({
          data: {
            requestId: randomUUID(),
            type: "ADD",
            amount,
            createdById: actor.id,
          },
        }),
      ).rejects.toThrow();
    await expect(
      db.companyMoneyTransaction.create({
        data: {
          requestId: randomUUID(),
          type: "REMOVE",
          amount: "0.01",
          createdById: actor.id,
        },
      }),
    ).rejects.toThrow();
    const admin = await db.user.create({
      data: { email: `${randomUUID()}@example.test`, role: "ADMIN" },
    });
    await expect(
      db.companyMoneyTransaction.create({
        data: {
          requestId: randomUUID(),
          type: "ADD",
          amount: "1",
          createdById: admin.id,
        },
      }),
    ).rejects.toThrow();
    const addition = await record("ADD", "10.00");
    for (const data of [
      { amount: new Prisma.Decimal("11") },
      { note: "Changed" },
      { date: new Date("2026-10-18T00:00:00.000Z") },
      { createdById: null },
    ])
      await expect(
        db.companyMoneyTransaction.update({ where: { id: addition.id }, data }),
      ).rejects.toThrow();
    await expect(
      db.companyMoneyTransaction.delete({ where: { id: addition.id } }),
    ).rejects.toThrow();
    expect((await getCompanyMoneyOverview(actor)).balance).toBe("10.00");
  });

  it("rejects direct writes with fixed snapshots that could bypass serialized balance checks", async () => {
    await record("ADD", "100.00");
    for (const isolationLevel of [
      Prisma.TransactionIsolationLevel.RepeatableRead,
      Prisma.TransactionIsolationLevel.Serializable,
    ]) {
      await expect(
        db.$transaction(
          (tx) =>
            tx.companyMoneyTransaction.create({
              data: {
                requestId: randomUUID(),
                type: "REMOVE",
                amount: "80.00",
                createdById: actor.id,
              },
            }),
          { isolationLevel },
        ),
      ).rejects.toThrow();
    }
    expect((await getCompanyMoneyOverview(actor)).balance).toBe("100.00");
    expect(await db.companyMoneyTransaction.count()).toBe(1);
  });

  it("preserves financial facts and removes author identity when its account is deleted", async () => {
    const target = await db.user.create({
      data: {
        name: "Deleted finance owner",
        email: `${randomUUID()}@example.test`,
        role: "SUPER_ADMIN",
      },
    });
    const transaction = await recordCompanyMoneyTransaction(target, {
      requestId: randomUUID(),
      type: "ADD",
      amount: "10.10",
      date: "2026-10-17",
      note: "Retained financial fact",
    });
    await deleteUser(actor, target.id);
    const overview = await getCompanyMoneyOverview(actor);
    expect(overview.items).toEqual([{ ...transaction, createdBy: null }]);
    expect(overview.balance).toBe("10.10");
    const audit = await db.auditLog.findFirstOrThrow({
      where: { resourceId: transaction.id },
    });
    expect(audit.actorId).toBeNull();
    expect(
      await db.companyMoneyMutationReceipt.findUniqueOrThrow({
        where: {
          requestId: (
            await db.companyMoneyTransaction.findUniqueOrThrow({
              where: { id: transaction.id },
            })
          ).requestId,
        },
      }),
    ).toMatchObject({ actorId: null });
    expect(JSON.stringify(audit)).not.toContain(target.email);
    expect(JSON.stringify(audit)).not.toContain(target.name);
  });
});
