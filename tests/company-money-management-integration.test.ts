import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  deleteCompanyMoneyTransaction,
  getCompanyMoneyOverview,
  recordCompanyMoneyTransaction,
  updateCompanyMoneyTransaction,
} from "@/modules/company-money/service";
import type { CompanyMoneyTransactionRecord } from "@/modules/company-money/contracts";
import { deleteIdentity } from "@/modules/management/delete-identity";

const database = process.env.TEST_DATABASE_URL;
const actor = { id: "", role: "SUPER_ADMIN" as const };

describe.skipIf(!database)("company money record management", () => {
  beforeAll(async () => {
    if (!database || !new URL(database).pathname.includes("test"))
      throw new Error(
        "Company money management tests require a disposable test database",
      );
    process.env.DATABASE_URL = database;
    actor.id = (
      await db.user.create({
        data: { email: `${randomUUID()}@example.test`, role: "SUPER_ADMIN" },
      })
    ).id;
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe(
      'TRUNCATE TABLE "CompanyMoneyTransaction", "CompanyMoneyMutationReceipt"',
    );
  });
  afterAll(async () => {
    if (actor.id)
      await db.$executeRawUnsafe(
        'TRUNCATE TABLE "CompanyMoneyTransaction", "CompanyMoneyMutationReceipt"',
      );
    await db.$disconnect();
  });

  function create(type: "ADD" | "REMOVE", amount: string) {
    return recordCompanyMoneyTransaction(actor, {
      requestId: randomUUID(),
      type,
      amount,
      date: "2026-10-17",
    });
  }
  function editInput(
    record: CompanyMoneyTransactionRecord,
    changed: Record<string, unknown> = {},
  ) {
    return {
      requestId: randomUUID(),
      expectedVersion: record.version,
      type: record.type,
      amount: record.amount,
      date: record.date,
      note: record.note ?? "",
      ...changed,
    };
  }
  function deletion(record: CompanyMoneyTransactionRecord) {
    return { requestId: randomUUID(), expectedVersion: record.version };
  }

  it("recalculates edits to both amounts and transaction types and keeps date/note corrections", async () => {
    await create("ADD", "200");
    let added = await create("ADD", "100");
    let removed = await create("REMOVE", "50");
    added = await updateCompanyMoneyTransaction(
      actor,
      added.id,
      editInput(added, {
        amount: "120",
        date: "2034-02-04",
        note: "Corrected",
      }),
    );
    expect(added).toMatchObject({
      version: 2,
      amount: "120.00",
      date: "2034-02-04",
      note: "Corrected",
    });
    expect(await getCompanyMoneyOverview(actor)).toMatchObject({
      balance: "270.00",
      totalAdded: "320.00",
      totalRemoved: "50.00",
    });
    removed = await updateCompanyMoneyTransaction(
      actor,
      removed.id,
      editInput(removed, { amount: "30" }),
    );
    expect((await getCompanyMoneyOverview(actor)).balance).toBe("290.00");
    added = await updateCompanyMoneyTransaction(
      actor,
      added.id,
      editInput(added, { type: "REMOVE", amount: "20" }),
    );
    expect((await getCompanyMoneyOverview(actor)).balance).toBe("150.00");
    await updateCompanyMoneyTransaction(
      actor,
      removed.id,
      editInput(removed, { type: "ADD", amount: "40" }),
    );
    expect(await getCompanyMoneyOverview(actor)).toMatchObject({
      balance: "220.00",
      totalAdded: "240.00",
      totalRemoved: "20.00",
    });
  });

  it("physically deletes additions and removals and adjusts the balance in opposite directions", async () => {
    await create("ADD", "500");
    const added = await create("ADD", "100");
    const removed = await create("REMOVE", "20");
    const request = deletion(added);
    expect(
      await deleteCompanyMoneyTransaction(actor, added.id, request),
    ).toEqual({ id: added.id });
    expect(
      await deleteCompanyMoneyTransaction(actor, added.id, request),
    ).toEqual({ id: added.id });
    expect((await getCompanyMoneyOverview(actor)).balance).toBe("480.00");
    await deleteCompanyMoneyTransaction(actor, removed.id, deletion(removed));
    expect(
      await db.companyMoneyTransaction.findUnique({ where: { id: added.id } }),
    ).toBeNull();
    expect(await getCompanyMoneyOverview(actor)).toMatchObject({
      balance: "500.00",
      total: 1,
    });
    expect(
      await db.auditLog.count({
        where: { resourceId: added.id, action: "COMPANY_MONEY_DELETED" },
      }),
    ).toBe(1);
  });

  it("rejects edits and deletions whose resulting delta would make the balance negative", async () => {
    const added = await create("ADD", "100");
    const removed = await create("REMOVE", "80");
    for (const changed of [{ amount: "30" }, { type: "REMOVE", amount: "1" }])
      await expect(
        updateCompanyMoneyTransaction(
          actor,
          added.id,
          editInput(added, changed),
        ),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_COMPANY_BALANCE" });
    await expect(
      updateCompanyMoneyTransaction(
        actor,
        removed.id,
        editInput(removed, { amount: "101" }),
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_COMPANY_BALANCE" });
    await expect(
      deleteCompanyMoneyTransaction(actor, added.id, deletion(added)),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_COMPANY_BALANCE" });
    expect(await getCompanyMoneyOverview(actor)).toMatchObject({
      balance: "20.00",
      total: 2,
    });
    expect(await db.companyMoneyMutationReceipt.count()).toBe(2);
  });

  it("requires current versions and records before/after audits with scalar identities", async () => {
    const record = await create("ADD", "100");
    const updated = await updateCompanyMoneyTransaction(
      actor,
      record.id,
      editInput(record, { amount: "120", note: "Correction" }),
    );
    await expect(
      updateCompanyMoneyTransaction(
        actor,
        record.id,
        editInput(record, { amount: "130" }),
      ),
    ).rejects.toMatchObject({ code: "TRANSACTION_CONFLICT" });
    await expect(
      deleteCompanyMoneyTransaction(actor, record.id, deletion(record)),
    ).rejects.toMatchObject({ code: "TRANSACTION_CONFLICT" });
    const audit = await db.auditLog.findFirstOrThrow({
      where: { resourceId: record.id, action: "COMPANY_MONEY_UPDATED" },
    });
    expect(audit.previousState).toMatchObject({ version: 1, amount: "100.00" });
    expect(audit.newState).toMatchObject({
      version: 2,
      amount: "120.00",
      note: "Correction",
    });
    expect(audit.newState).not.toHaveProperty("createdBy");
    await deleteCompanyMoneyTransaction(actor, record.id, deletion(updated));
    expect(
      (
        await db.auditLog.findFirstOrThrow({
          where: { resourceId: record.id, action: "COMPANY_MONEY_DELETED" },
        })
      ).previousState,
    ).toMatchObject({ version: 2, amount: "120.00" });
  });

  it("replays ambiguous edit responses exactly once but never overwrites a later edit or deletion", async () => {
    const record = await create("ADD", "100");
    const input = editInput(record, { amount: "120.10" });
    const [first, retry] = await Promise.all([
      updateCompanyMoneyTransaction(actor, record.id, input),
      updateCompanyMoneyTransaction(actor, record.id, input),
    ]);
    expect(retry).toEqual(first);
    expect(
      await updateCompanyMoneyTransaction(actor, record.id, {
        ...input,
        amount: "120.1",
      }),
    ).toEqual(first);
    expect(
      await db.auditLog.count({
        where: { resourceId: record.id, action: "COMPANY_MONEY_UPDATED" },
      }),
    ).toBe(1);
    const later = await updateCompanyMoneyTransaction(
      actor,
      record.id,
      editInput(first, { amount: "130" }),
    );
    await expect(
      updateCompanyMoneyTransaction(actor, record.id, input),
    ).rejects.toMatchObject({ code: "TRANSACTION_CONFLICT" });
    await deleteCompanyMoneyTransaction(actor, record.id, deletion(later));
    await expect(
      updateCompanyMoneyTransaction(actor, record.id, input),
    ).rejects.toMatchObject({ code: "TRANSACTION_DELETED" });
    await expect(
      updateCompanyMoneyTransaction(actor, record.id, {
        ...input,
        amount: "121",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("never reapplies original create submissions after edit or physical deletion, even with a new UUID for the same ID", async () => {
    const input = {
      requestId: randomUUID(),
      type: "ADD",
      amount: "100",
      date: "2026-10-17",
    };
    const record = await recordCompanyMoneyTransaction(actor, input);
    const updated = await updateCompanyMoneyTransaction(
      actor,
      record.id,
      editInput(record, { amount: "120" }),
    );
    await expect(
      recordCompanyMoneyTransaction(actor, input),
    ).rejects.toMatchObject({ code: "TRANSACTION_CONFLICT" });
    await deleteCompanyMoneyTransaction(actor, record.id, deletion(updated));
    await expect(
      recordCompanyMoneyTransaction(actor, input),
    ).rejects.toMatchObject({ code: "TRANSACTION_DELETED" });
    await expect(
      db.companyMoneyTransaction.create({
        data: {
          id: record.id,
          requestId: randomUUID(),
          type: "ADD",
          amount: "100",
          createdById: actor.id,
        },
      }),
    ).rejects.toThrow();
    expect(await getCompanyMoneyOverview(actor)).toMatchObject({
      balance: "0.00",
      total: 0,
    });
  });

  it("rejects UUID reuse for a different actor, target, operation, or expected version", async () => {
    const record = await create("ADD", "100");
    const input = editInput(record, { amount: "120" });
    const updated = await updateCompanyMoneyTransaction(
      actor,
      record.id,
      input,
    );
    const other = await db.user.create({
      data: { email: `${randomUUID()}@example.test`, role: "SUPER_ADMIN" },
    });
    await expect(
      updateCompanyMoneyTransaction(other, record.id, input),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      updateCompanyMoneyTransaction(actor, "other-target", input),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      updateCompanyMoneyTransaction(actor, record.id, {
        ...input,
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      deleteCompanyMoneyTransaction(actor, record.id, {
        requestId: input.requestId,
        expectedVersion: updated.version,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("serializes competing edit and delete operations at the same version", async () => {
    await create("ADD", "500");
    const record = await create("ADD", "100");
    const results = await Promise.allSettled([
      updateCompanyMoneyTransaction(
        actor,
        record.id,
        editInput(record, { amount: "200" }),
      ),
      deleteCompanyMoneyTransaction(actor, record.id, deletion(record)),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(["500.00", "700.00"]).toContain(
      (await getCompanyMoneyOverview(actor)).balance,
    );
  });

  it.each(["edit", "delete"] as const)(
    "serializes %s deltas with a concurrent withdrawal",
    async (operation) => {
      const record = await create("ADD", "100");
      const change =
        operation === "edit"
          ? updateCompanyMoneyTransaction(
              actor,
              record.id,
              editInput(record, { amount: "20" }),
            )
          : deleteCompanyMoneyTransaction(actor, record.id, deletion(record));
      const results = await Promise.allSettled([
        change,
        create("REMOVE", "80"),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(["0.00", "20.00"]).toContain(
        (await getCompanyMoneyOverview(actor)).balance,
      );
    },
  );

  it.each(["ADMIN", "EMPLOYEE", "MANAGE_DRIVER"] as const)(
    "denies direct %s edits and deletions",
    async (role) => {
      await expect(
        updateCompanyMoneyTransaction({ id: actor.id, role }, "record", {}),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        deleteCompanyMoneyTransaction({ id: actor.id, role }, "record", {}),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it("rechecks active persisted superadmin access for edits and deletes", async () => {
    const record = await create("ADD", "100");
    const target = await db.user.create({
      data: { email: `${randomUUID()}@example.test`, role: "ADMIN" },
    });
    const stale = { id: target.id, role: "SUPER_ADMIN" as const };
    for (const action of [
      () => updateCompanyMoneyTransaction(stale, record.id, editInput(record)),
      () => deleteCompanyMoneyTransaction(stale, record.id, deletion(record)),
    ]) {
      await expect(action()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await db.user.update({
      where: { id: target.id },
      data: { role: "SUPER_ADMIN", status: "INACTIVE" },
    });
    await expect(
      deleteCompanyMoneyTransaction(stale, record.id, deletion(record)),
    ).rejects.toMatchObject({ code: "USER_INACTIVE" });
  });

  it("keeps receipts immutable and blocks direct SQL bypasses of editor, version, balance and isolation checks", async () => {
    const added = await create("ADD", "100");
    await create("REMOVE", "80");
    await expect(
      db.companyMoneyTransaction.delete({ where: { id: added.id } }),
    ).rejects.toThrow();
    const receipt = await db.companyMoneyMutationReceipt.findFirstOrThrow({
      where: { transactionId: added.id },
    });
    await expect(
      db.companyMoneyMutationReceipt.delete({
        where: { requestId: receipt.requestId },
      }),
    ).rejects.toThrow();
    await expect(
      db.companyMoneyMutationReceipt.update({
        where: { requestId: receipt.requestId },
        data: { payload: {} },
      }),
    ).rejects.toThrow();
    for (const data of [
      { amount: "10", version: 2 },
      { note: "Changed" },
      { requestId: randomUUID(), version: 2 },
    ]) {
      await expect(
        db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.company_money_editor_id', ${actor.id}, true)`;
          return tx.companyMoneyTransaction.update({
            where: { id: added.id },
            data,
          });
        }),
      ).rejects.toThrow();
    }
    await expect(
      db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.company_money_editor_id', ${actor.id}, true)`;
        return tx.companyMoneyTransaction.delete({ where: { id: added.id } });
      }),
    ).rejects.toThrow();
    await expect(
      db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.company_money_editor_id', ${actor.id}, true)`;
          return tx.companyMoneyTransaction.update({
            where: { id: added.id },
            data: { note: "Changed", version: 2 },
          });
        },
        { isolationLevel: "RepeatableRead" },
      ),
    ).rejects.toThrow();
    expect((await getCompanyMoneyOverview(actor)).balance).toBe("20.00");
  });

  it.each(["edit", "delete"] as const)(
    "re-reads an author deleted concurrently with %s before writing new audit snapshots",
    async (operation) => {
      const author = await db.user.create({
        data: { email: `${randomUUID()}@example.test`, role: "SUPER_ADMIN" },
      });
      const record = await recordCompanyMoneyTransaction(author, {
        requestId: randomUUID(),
        type: "ADD",
        amount: "100",
        date: "2026-10-17",
      });
      let releaseDeletion!: () => void;
      let signalLocked!: () => void;
      let deletingPid = 0;
      const proceed = new Promise<void>((resolve) => {
        releaseDeletion = resolve;
      });
      const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      const deleting = db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actor.id} FOR SHARE`;
          await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${author.id} FOR UPDATE`;
          deletingPid = (
            await tx.$queryRaw<
              { pid: number }[]
            >`SELECT pg_backend_pid() AS pid`
          )[0].pid;
          signalLocked();
          await proceed;
          await deleteIdentity(tx, actor, author.id, undefined, author);
        },
        { timeout: 10000 },
      );
      await locked;
      const mutation =
        operation === "edit"
          ? updateCompanyMoneyTransaction(
              actor,
              record.id,
              editInput(record, { note: "Correction after author deletion" }),
            )
          : deleteCompanyMoneyTransaction(actor, record.id, deletion(record));
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 50 && !blocked; attempt++) {
          blocked = (
            await db.$queryRaw<{ blocked: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE ${deletingPid} = ANY(pg_blocking_pids(pid))) AS blocked
        `
          )[0].blocked;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(blocked).toBe(true);
      } finally {
        releaseDeletion();
      }
      await deleting;
      await mutation;
      const audit = await db.auditLog.findFirstOrThrow({
        where: {
          resourceId: record.id,
          action:
            operation === "edit"
              ? "COMPANY_MONEY_UPDATED"
              : "COMPANY_MONEY_DELETED",
        },
      });
      expect(audit.previousState).toMatchObject({
        createdById: null,
        amount: "100.00",
      });
      expect(JSON.stringify(audit)).not.toContain(author.id);
      expect(JSON.stringify(audit)).not.toContain(author.email);
    },
  );
});
