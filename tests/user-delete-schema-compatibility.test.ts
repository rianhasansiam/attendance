import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Replace only the connection; deletion and its constraints run in PostgreSQL.
const isolated = vi.hoisted(() => ({
  client: undefined as PrismaClient | undefined,
}));
vi.mock("@/lib/db", () => ({
  db: new Proxy(
    {},
    {
      get(_target, key) {
        if (!isolated.client)
          throw new Error("The isolated test database is not ready");
        const value = Reflect.get(isolated.client, key);
        return typeof value === "function"
          ? value.bind(isolated.client)
          : value;
      },
    },
  ),
}));

import { deleteUser } from "@/modules/management/workflows";

const testDatabase = process.env.TEST_DATABASE_URL;
const integration = testDatabase ? describe : describe.skip;
const upgrade = "20260930000000_hard_delete_daily_expenses";

integration.each(["legacy", "upgraded"] as const)(
  "user deletion with the %s Daily Expenses schema",
  (version) => {
    const schema = `user_delete_${version}_${randomUUID().replaceAll("-", "")}`;
    let control: Client;
    let db: PrismaClient;
    let actor: { id: string; role: "SUPER_ADMIN" };
    let officeId: string;
    let ledgerId: string;

    beforeAll(async () => {
      if (!testDatabase || !new URL(testDatabase).pathname.includes("test"))
        throw new Error(
          "TEST_DATABASE_URL must identify an isolated test database",
        );
      control = new Client({ connectionString: testDatabase });
      await control.connect();
      await control.query(`CREATE SCHEMA "${schema}"`);
      await control.query(`SET search_path TO "${schema}"`);
      const directory = path.join(process.cwd(), "prisma/migrations");
      for (const migration of (await readdir(directory)).sort()) {
        if (
          migration === "migration_lock.toml" ||
          // Only retain the legacy expense schema; unrelated later migrations
          // must still match the current Prisma client (for example profiles).
          (version === "legacy" && migration === upgrade)
        )
          continue;
        const sql = await readFile(
          path.join(directory, migration, "migration.sql"),
          "utf8",
        );
        await control.query(
          sql.replace('CREATE SCHEMA IF NOT EXISTS "public";', ""),
        );
      }
      db = new PrismaClient({
        adapter: new PrismaPg(
          {
            connectionString: testDatabase,
            options: `-c search_path=${schema}`,
            application_name: schema,
          },
          { schema },
        ),
      });
      isolated.client = db;
      actor = {
        ...(await db.user.create({
          data: {
            email: `${randomUUID()}@example.test`,
            role: "SUPER_ADMIN",
          },
        })),
        role: "SUPER_ADMIN",
      };
      officeId = (
        await db.office.create({
          data: {
            name: schema,
            address: "Isolated test office",
            latitude: 0,
            longitude: 0,
          },
        })
      ).id;
      ledgerId = (
        await db.dailyExpenseLedger.create({
          data: {
            workspaceKey: "daily-expenses",
            currency: "BDT",
            timezone: "Asia/Dhaka",
          },
        })
      ).id;
      expect(
        (
          await control.query(
            `SELECT to_regclass('"DailyExpenseTransactionDeletion"') IS NOT NULL AS "exists"`,
          )
        ).rows,
      ).toEqual([{ exists: version === "upgraded" }]);
    }, 60_000);

    afterAll(async () => {
      isolated.client = undefined;
      await db?.$disconnect();
      if (control) {
        await control.query("ROLLBACK");
        await control.query('SET search_path TO "public"');
        await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await control.end();
      }
    });

    async function user(withProfile = false) {
      return db.user.create({
        data: {
          email: `${randomUUID()}@example.test`,
          role: withProfile ? "EMPLOYEE" : "ADMIN",
          ...(withProfile
            ? {
                employee: {
                  create: { employeeCode: randomUUID(), officeId },
                },
              }
            : {}),
        },
        include: { employee: true },
      });
    }

    async function financialRecord(createdById: string) {
      return db.dailyExpenseTransaction.create({
        data: {
          ledgerId,
          type: "BALANCE_ADDED",
          amount: "10.00",
          date: new Date("2024-01-01"),
          createdById,
          idempotencyKey: randomUUID(),
          payloadHash: "a".repeat(64),
        },
      });
    }

    async function expectDeleted(id: string) {
      await expect(deleteUser(actor, id)).resolves.toEqual({ id });
      expect(await db.user.findUnique({ where: { id } })).toBeNull();
      expect(
        await db.auditLog.count({
          where: { resourceId: id, action: "USER_DELETED" },
        }),
      ).toBe(1);
    }

    it("deletes an unused user, employee profile, and sign-in data atomically", async () => {
      const target = await user(true);
      const employeeId = target.employee!.id;
      await db.account.create({
        data: {
          userId: target.id,
          type: "oidc",
          provider: "google",
          providerAccountId: randomUUID(),
        },
      });
      await db.session.create({
        data: {
          userId: target.id,
          sessionToken: randomUUID(),
          expires: new Date(Date.now() + 3600000),
        },
      });
      await db.passwordResetToken.create({
        data: {
          userId: target.id,
          email: target.email,
          tokenHash: randomUUID(),
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      await db.webAuthnCredential.create({
        data: {
          employeeId,
          name: "Test passkey",
          credentialId: randomUUID(),
          publicKey: new Uint8Array([1]),
          transports: [],
          deviceType: "singleDevice",
        },
      });
      await db.webAuthnChallenge.create({
        data: {
          employeeId,
          sessionId: randomUUID(),
          challenge: randomUUID(),
          purpose: "REGISTRATION",
          expiresAt: new Date(Date.now() + 3600000),
        },
      });

      expect(await deleteUser(actor, target.id)).toEqual({ id: target.id });
      expect(await db.user.findUnique({ where: { id: target.id } })).toBeNull();
      expect(await db.employee.count({ where: { userId: target.id } })).toBe(0);
      expect(await db.account.count({ where: { userId: target.id } })).toBe(0);
      expect(await db.session.count({ where: { userId: target.id } })).toBe(0);
      expect(
        await db.passwordResetToken.count({ where: { userId: target.id } }),
      ).toBe(0);
      expect(await db.webAuthnCredential.count({ where: { employeeId } })).toBe(
        0,
      );
      expect(await db.webAuthnChallenge.count({ where: { employeeId } })).toBe(
        0,
      );
      expect(
        await db.auditLog.findFirst({
          where: { resourceId: target.id, action: "USER_DELETED" },
        }),
      ).toMatchObject({
        actorId: actor.id,
        previousState: expect.objectContaining({ id: "deleted info" }),
      });
    });

    it("deletes the user and preserves financial history without their identity", async () => {
      const target = await user();
      const record = await financialRecord(target.id);
      await expectDeleted(target.id);
      expect(
        await db.dailyExpenseTransaction.findUnique({
          where: { id: record.id },
        }),
      ).toEqual({ ...record, createdById: null });
    });

    if (version === "legacy") {
      it("preserves a legacy soft-deleted expense when its user is deleted", async () => {
        const target = await user();
        const record = await financialRecord(target.id);
        await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.daily_expenses_editor_id', ${actor.id}, true)`;
          await tx.$executeRaw`UPDATE "DailyExpenseTransaction" SET "deletedAt" = NOW(), "version" = 2 WHERE "id" = ${record.id}`;
        });

        await expectDeleted(target.id);
        expect(
          (
            await control.query(
              'SELECT "createdById", "deletedAt", "amount" FROM "DailyExpenseTransaction" WHERE "id" = $1',
              [record.id],
            )
          ).rows,
        ).toEqual([
          {
            createdById: null,
            deletedAt: expect.any(Date),
            amount: "10.00",
          },
        ]);
      });
    } else {
      it("keeps the immutable expense receipt after deleting its user", async () => {
        const target = await user();
        const record = await financialRecord(target.id);
        await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.daily_expenses_editor_id', ${actor.id}, true)`;
          await tx.dailyExpenseTransaction.delete({ where: { id: record.id } });
        });
        expect(
          await db.dailyExpenseTransaction.findUnique({
            where: { id: record.id },
          }),
        ).toBeNull();
        expect(await db.auditLog.count({ where: { actorId: target.id } })).toBe(
          0,
        );
        const receipt = await db.dailyExpenseTransactionDeletion.findUnique({
          where: { transactionId: record.id },
        });
        expect(receipt).toMatchObject({ createdById: target.id });

        await expectDeleted(target.id);
        expect(
          await db.dailyExpenseTransactionDeletion.findUnique({
            where: { transactionId: record.id },
          }),
        ).toEqual({ ...receipt, createdById: null });
      });
    }
  },
);
