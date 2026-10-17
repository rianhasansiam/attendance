import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const database = process.env.TEST_DATABASE_URL;
function migration(name: string) {
  return readFileSync(
    new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url),
    "utf8",
  );
}

describe.skipIf(!database)("company money record management migration", () => {
  it("preserves existing facts and captures durable original create receipts including old-client inserts", async () => {
    if (!database || !new URL(database).pathname.includes("test"))
      throw new Error(
        "Company money migration tests require a disposable test database",
      );
    const client = new Client({ connectionString: database });
    const schema = `company_money_management_${randomUUID().replaceAll("-", "")}`;
    const requestId = randomUUID();
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(
        `CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "role" TEXT NOT NULL, "status" TEXT NOT NULL); INSERT INTO "User" VALUES ('owner', 'SUPER_ADMIN', 'ACTIVE')`,
      );
      await client.query(migration("20261015120000_company_money"));
      await client.query(migration("20261017120000_company_money_date"));
      await client.query(
        `INSERT INTO "CompanyMoneyTransaction" ("id","requestId","type","amount","date","note","createdById","createdAt") VALUES ('legacy',$1,'ADD',100.10,'2026-09-30','Original business facts','owner','2026-10-17T08:10:00')`,
        [requestId],
      );
      const before = (
        await client.query('SELECT * FROM "CompanyMoneyTransaction"')
      ).rows[0];

      await client.query(
        migration("20261017130000_company_money_record_management"),
      );

      expect(
        (await client.query('SELECT * FROM "CompanyMoneyTransaction"')).rows,
      ).toEqual([{ ...before, version: 1 }]);
      expect(
        (await client.query('SELECT * FROM "CompanyMoneyMutationReceipt"'))
          .rows,
      ).toEqual([
        expect.objectContaining({
          requestId,
          transactionId: "legacy",
          operation: "CREATE",
          actorId: "owner",
          payload: {
            type: "ADD",
            amount: "100.10",
            date: "2026-09-30",
            note: "Original business facts",
          },
          resultVersion: 1,
          createdAt: before.createdAt,
        }),
      ]);
      await client.query(
        `INSERT INTO "CompanyMoneyTransaction" ("id","requestId","type","amount","createdById") VALUES ('old-client',$1,'ADD',50.00,'owner')`,
        [randomUUID()],
      );
      expect(
        (
          await client.query(
            `SELECT "resultVersion" FROM "CompanyMoneyMutationReceipt" WHERE "transactionId"='old-client'`,
          )
        ).rows,
      ).toEqual([{ resultVersion: 1 }]);
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.company_money_editor_id', 'owner', true)",
      );
      await client.query(
        `DELETE FROM "CompanyMoneyTransaction" WHERE "id"='legacy'`,
      );
      await client.query("COMMIT");
      for (const [id, retryId] of [
        ["legacy", randomUUID()],
        ["another-id", requestId],
      ]) {
        await expect(
          client.query(
            `INSERT INTO "CompanyMoneyTransaction" ("id","requestId","type","amount","createdById") VALUES ($1,$2,'ADD',100.10,'owner')`,
            [id, retryId],
          ),
        ).rejects.toThrow(
          "Existing company money submissions cannot be recreated",
        );
      }
      await expect(
        client.query(
          `DELETE FROM "CompanyMoneyMutationReceipt" WHERE "transactionId"='legacy'`,
        ),
      ).rejects.toThrow("Company money mutation receipts are immutable");
    } finally {
      await client.query("ROLLBACK");
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });
});
