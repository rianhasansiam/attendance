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

describe.skipIf(!database)("company money transaction date migration", () => {
  it("backfills Dhaka dates across midnight/year boundaries and restores immutable history", async () => {
    if (!database || !new URL(database).pathname.includes("test"))
      throw new Error(
        "Company money migration tests require a disposable test database",
      );
    const client = new Client({ connectionString: database });
    const schema = `company_money_date_${randomUUID().replaceAll("-", "")}`;
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE "User" (
          "id" TEXT PRIMARY KEY,
          "role" TEXT NOT NULL,
          "status" TEXT NOT NULL
        );
        INSERT INTO "User" VALUES ('owner', 'SUPER_ADMIN', 'ACTIVE');
      `);
      await client.query(migration("20261015120000_company_money"));
      for (const [id, createdAt] of [
        ["before-midnight", "2026-10-16T17:59:59.999"],
        ["after-midnight", "2026-10-16T18:00:00.000"],
        ["new-year", "2026-12-31T20:00:00.000"],
      ]) {
        await client.query(
          `
          INSERT INTO "CompanyMoneyTransaction"
            ("id", "requestId", "type", "amount", "note", "createdById", "createdAt")
          VALUES ($1, $2, 'ADD', 1.25, 'Legacy company funds', 'owner', $3)
        `,
          [id, randomUUID(), createdAt],
        );
      }
      const before = (
        await client.query(
          'SELECT * FROM "CompanyMoneyTransaction" ORDER BY "id"',
        )
      ).rows;

      await client.query(migration("20261017120000_company_money_date"));

      const after = (
        await client.query(`
        SELECT "id", "requestId", "type", "amount", "note", "createdById", "createdAt"
        FROM "CompanyMoneyTransaction" ORDER BY "id"
      `)
      ).rows;
      expect(after).toEqual(before);
      expect(
        (
          await client.query(`
        SELECT "id", "date"::text AS "date" FROM "CompanyMoneyTransaction" ORDER BY "id"
      `)
        ).rows,
      ).toEqual([
        { id: "after-midnight", date: "2026-10-17" },
        { id: "before-midnight", date: "2026-10-16" },
        { id: "new-year", date: "2027-01-01" },
      ]);
      expect(
        (
          await client.query(`
        SELECT "tgenabled" FROM pg_trigger
        WHERE "tgrelid" = '"CompanyMoneyTransaction"'::regclass
          AND "tgname" = 'CompanyMoneyTransaction_immutable'
      `)
        ).rows,
      ).toEqual([{ tgenabled: "O" }]);
      await expect(
        client.query(`
        UPDATE "CompanyMoneyTransaction" SET "date" = '2026-10-18' WHERE "id" = 'after-midnight'
      `),
      ).rejects.toThrow("Company money history is immutable");
      await expect(
        client.query(
          `DELETE FROM "CompanyMoneyTransaction" WHERE "id" = 'after-midnight'`,
        ),
      ).rejects.toThrow("Company money history is immutable");

      // Old deployed clients omit date. The DB supplies the current Dhaka day,
      // independently of the database session's selected timezone.
      await client.query("SET timezone TO 'America/Los_Angeles'");
      const [inserted] = (
        await client.query(
          `
        INSERT INTO "CompanyMoneyTransaction"
          ("id", "requestId", "type", "amount", "createdById")
        VALUES ('old-client', $1, 'ADD', 0.01, 'owner')
        RETURNING "date"::text AS "date",
          (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Dhaka')::date::text AS "expected"
      `,
          [randomUUID()],
        )
      ).rows;
      expect(inserted.date).toBe(inserted.expected);
      expect(
        (
          await client.query(
            `
        SELECT "indexdef" FROM pg_indexes
        WHERE "schemaname" = $1 AND "indexname" = 'CompanyMoneyTransaction_date_createdAt_id_idx'
      `,
            [schema],
          )
        ).rows[0].indexdef,
      ).toContain('(date DESC, "createdAt" DESC, id DESC)');
    } finally {
      await client.query("ROLLBACK");
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });
});
