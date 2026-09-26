import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { expect, it } from "vitest";

const testDatabase = process.env.TEST_DATABASE_URL;
const integration = testDatabase ? it : it.skip;

integration(
  "converts old soft-deleted expenses to minimal receipts while preserving live records and audits",
  async () => {
    if (!testDatabase || !new URL(testDatabase).pathname.includes("test")) {
      throw new Error(
        "TEST_DATABASE_URL must identify an isolated test database",
      );
    }
    const schema = `daily_expenses_upgrade_${randomUUID().replaceAll("-", "")}`;
    const client = new Client({ connectionString: testDatabase });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      const directory = path.join(process.cwd(), "prisma/migrations");
      const upgrade = "20260930000000_hard_delete_daily_expenses";
      for (const migration of (await readdir(directory)).sort()) {
        if (migration === "migration_lock.toml" || migration >= upgrade)
          continue;
        const sql = await readFile(
          path.join(directory, migration, "migration.sql"),
          "utf8",
        );
        await client.query(
          sql.replace('CREATE SCHEMA IF NOT EXISTS "public";', ""),
        );
      }
      await client.query(
        `INSERT INTO "User" ("id", "email", "role", "updatedAt") VALUES ('editor', 'upgrade@example.test', 'SUPER_ADMIN', NOW())`,
      );
      await client.query(
        `INSERT INTO "DailyExpenseLedger" ("id", "workspaceKey", "currency", "timezone") VALUES ('ledger', 'daily-expenses', 'BDT', 'Asia/Dhaka')`,
      );
      for (const id of ["live", "deleted"]) {
        await client.query(
          `INSERT INTO "DailyExpenseTransaction" ("id", "ledgerId", "type", "amount", "date", "note", "createdById", "idempotencyKey", "payloadHash") VALUES ($1, 'ledger', 'BALANCE_ADDED', 10, DATE '2024-01-01', 'Original note', 'editor', $2, $3)`,
          [id, `${id}-submission-key`, "a".repeat(64)],
        );
      }
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.daily_expenses_editor_id', 'editor', true)",
      );
      await client.query(
        `UPDATE "DailyExpenseTransaction" SET "deletedAt" = TIMESTAMP '2024-02-01', "version" = 2 WHERE "id" = 'deleted'`,
      );
      await client.query(
        `INSERT INTO "AuditLog" ("id", "actorId", "action", "resource", "resourceId", "previousState") VALUES ('audit', 'editor', 'DAILY_EXPENSE_TRANSACTION_DELETED', 'DailyExpenseTransaction', 'deleted', '{"amount":"10.00"}')`,
      );
      await client.query("COMMIT");
      const originalDeletion = (
        await client.query(
          `SELECT "deletedAt" FROM "DailyExpenseTransaction" WHERE "id" = 'deleted'`,
        )
      ).rows[0].deletedAt;
      await client.query(
        await readFile(path.join(directory, upgrade, "migration.sql"), "utf8"),
      );

      expect(
        (
          await client.query(
            'SELECT "id", "version", "amount" FROM "DailyExpenseTransaction"',
          )
        ).rows,
      ).toEqual([{ id: "live", version: 1, amount: "10.00" }]);
      const receipts = (
        await client.query('SELECT * FROM "DailyExpenseTransactionDeletion"')
      ).rows;
      expect(receipts).toEqual([
        {
          transactionId: "deleted",
          ledgerId: "ledger",
          idempotencyKey: "deleted-submission-key",
          createdById: "editor",
          payloadHash: "a".repeat(64),
          deletedAt: originalDeletion,
        },
      ]);
      expect(
        (await client.query('SELECT "previousState" FROM "AuditLog"')).rows,
      ).toEqual([{ previousState: { amount: "10.00" } }]);
      expect(
        (
          await client.query(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'DailyExpenseTransaction' AND column_name = 'deletedAt'`,
            [schema],
          )
        ).rows,
      ).toEqual([]);
      await expect(
        client.query(
          `INSERT INTO "DailyExpenseTransaction" ("id", "ledgerId", "type", "amount", "date", "createdById", "idempotencyKey", "payloadHash") VALUES ('retry', 'ledger', 'BALANCE_ADDED', 10, DATE '2024-01-01', 'editor', 'deleted-submission-key', $1)`,
          ["a".repeat(64)],
        ),
      ).rejects.toThrow("cannot be recreated");
    } finally {
      await client.query("ROLLBACK");
      await client.query('SET search_path TO "public"');
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  },
  60_000,
);
