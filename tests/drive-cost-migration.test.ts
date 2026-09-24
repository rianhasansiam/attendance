import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const database = process.env.TEST_DATABASE_URL;
const integration = database ? describe : describe.skip;

function migration(name: string) {
  return readFileSync(
    new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url),
    "utf8",
  );
}

integration("drive cost round-trip migration", () => {
  it("preserves legacy costs, defaults to one way, and enforces both trip calculations", async () => {
    if (!database || !new URL(database).pathname.includes("test"))
      throw new Error("Migration tests require an isolated test database");
    const client = new Client({ connectionString: database });
    const schema = `drive_cost_${randomUUID().replaceAll("-", "")}`;
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const name of [
        "20260919000000_initial",
        "20260920000000_attendance_recent_index",
        "20260921000000_attendance_late_reason",
        "20260922000000_attendance_overtime",
        "20260923000000_drive_costs",
      ]) {
        await client.query(migration(name));
      }
      await client.query(`
        INSERT INTO "User" (id,email,"updatedAt")
          VALUES ('admin','drive-cost-migration@example.test',now());
        INSERT INTO "DriveCost" (id,date,"destinationFrom","destinationTo",
          kilometers,"rateType","ratePerKilometer","totalCost","createdById","updatedAt") VALUES
          ('legacy-in','2026-09-22','Office','Warehouse',12.34,'IN_TIME',5.00,61.70,'admin',now()),
          ('legacy-over','2026-09-22','Office','Warehouse',0.03,'OVER_TIME',10.00,0.30,'admin',now());
      `);
      const before = (
        await client.query('SELECT * FROM "DriveCost" ORDER BY id')
      ).rows;

      await client.query(migration("20260924000000_drive_cost_round_trips"));

      expect(
        (await client.query('SELECT * FROM "DriveCost" ORDER BY id')).rows,
      ).toEqual(before.map((record) => ({ ...record, isRoundTrip: false })));

      await client.query(`
        INSERT INTO "DriveCost" (id,date,"destinationFrom","destinationTo",
          kilometers,"rateType","ratePerKilometer","totalCost","createdById","updatedAt")
          VALUES ('default-trip','2026-09-22','Office','Warehouse',12.34,'IN_TIME',5.00,61.70,'admin',now());
        INSERT INTO "DriveCost" (id,date,"destinationFrom","destinationTo",
          kilometers,"rateType","ratePerKilometer","totalCost","isRoundTrip","createdById","updatedAt") VALUES
          ('round-in','2026-09-22','Office','Warehouse',12.34,'IN_TIME',5.00,123.40,true,'admin',now()),
          ('round-over','2026-09-22','Office','Warehouse',0.03,'OVER_TIME',10.00,0.60,true,'admin',now());
      `);
      expect(
        (
          await client.query(`
            SELECT id,kilometers,"isRoundTrip","totalCost" FROM "DriveCost"
            WHERE id IN ('default-trip','round-in','round-over') ORDER BY id
          `)
        ).rows,
      ).toEqual([
        {
          id: "default-trip",
          kilometers: "12.34",
          isRoundTrip: false,
          totalCost: "61.70",
        },
        {
          id: "round-in",
          kilometers: "12.34",
          isRoundTrip: true,
          totalCost: "123.40",
        },
        {
          id: "round-over",
          kilometers: "0.03",
          isRoundTrip: true,
          totalCost: "0.60",
        },
      ]);

      for (const [id, invalidCost] of [
        ["legacy-in", "123.40"],
        ["legacy-over", "0.60"],
        ["round-in", "61.70"],
        ["round-over", "0.30"],
      ]) {
        await client.query("SAVEPOINT invalid_drive_cost");
        await expect(
          client.query('UPDATE "DriveCost" SET "totalCost"=$1 WHERE id=$2', [
            invalidCost,
            id,
          ]),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "DriveCost_total_valid",
        });
        await client.query("ROLLBACK TO SAVEPOINT invalid_drive_cost");
      }

      const beforePaymentStatus = (
        await client.query('SELECT * FROM "DriveCost" ORDER BY id')
      ).rows;
      await client.query(migration("20260926000000_drive_cost_payment_status"));
      expect(
        (await client.query('SELECT * FROM "DriveCost" ORDER BY id')).rows,
      ).toEqual(
        beforePaymentStatus.map((record) => ({
          ...record,
          paymentStatus: "UNPAID",
        })),
      );
      await client.query(
        `UPDATE "DriveCost" SET "paymentStatus"='PAID' WHERE id='legacy-in'`,
      );
      expect(
        (
          await client.query(
            `SELECT "paymentStatus" FROM "DriveCost" WHERE id='legacy-in'`,
          )
        ).rows[0],
      ).toEqual({ paymentStatus: "PAID" });
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});
