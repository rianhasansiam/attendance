import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const database = process.env.TEST_DATABASE_URL;
const rateMigration = "20261003120000_drive_cost_rate_change";

function migration(name: string) {
  return readFileSync(
    new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url),
    "utf8",
  );
}

describe.skipIf(!database)("drive cost dated rate migration", () => {
  it("updates paid and unpaid trips from September 26, rounds the complete trip, and enforces dated rates", async () => {
    if (!database || !new URL(database).pathname.includes("test"))
      throw new Error("Migration tests require an isolated test database");
    const client = new Client({ connectionString: database });
    const schema = `drive_cost_rates_${randomUUID().replaceAll("-", "")}`;
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const name of [
        "20260919000000_initial",
        "20260923000000_drive_costs",
        "20260924000000_drive_cost_round_trips",
        "20260926000000_drive_cost_payment_status",
      ]) {
        await client.query(migration(name));
      }
      await client.query(`
        INSERT INTO "User" (id,email,"updatedAt")
          VALUES ('admin','drive-cost-rate-migration@example.test',now());
        INSERT INTO "DriveCost" (id,date,"destinationFrom","destinationTo",
          kilometers,"rateType","ratePerKilometer","totalCost","isRoundTrip",
          "paymentStatus","createdById","updatedAt") VALUES
          ('before-in','2026-09-25','Office','Warehouse',12.35,'IN_TIME',5.00,61.75,false,'PAID','admin',now()),
          ('before-over','2026-09-25','Warehouse','Office',0.03,'OVER_TIME',10.00,0.60,true,'UNPAID','admin',now()),
          ('cutoff-in-unpaid','2026-09-26','Office','Warehouse',0.01,'IN_TIME',5.00,0.05,false,'UNPAID','admin',now()),
          ('cutoff-in-paid','2026-09-26','Office','Warehouse',12.35,'IN_TIME',5.00,61.75,false,'PAID','admin',now()),
          ('cutoff-over-paid','2026-09-26','Office','Warehouse',12.34,'OVER_TIME',10.00,123.40,false,'PAID','admin',now()),
          ('cutoff-over-unpaid-round','2026-09-26','Office','Warehouse',0.03,'OVER_TIME',10.00,0.60,true,'UNPAID','admin',now()),
          ('after-in-round-paid','2026-09-27','Office','Warehouse',0.01,'IN_TIME',5.00,0.10,true,'PAID','admin',now()),
          ('after-over-unpaid','2026-09-27','Office','Warehouse',50.00,'OVER_TIME',10.00,500.00,false,'UNPAID','admin',now()),
          ('future-in','2027-01-01','Office','Warehouse',3.33,'IN_TIME',5.00,16.65,false,'UNPAID','admin',now());
      `);
      const before = (
        await client.query('SELECT * FROM "DriveCost" ORDER BY id')
      ).rows;

      await client.query(migration(rateMigration));

      const changedCosts: Record<
        string,
        { ratePerKilometer: string; totalCost: string }
      > = {
        "cutoff-in-unpaid": { ratePerKilometer: "5.50", totalCost: "0.06" },
        "cutoff-in-paid": { ratePerKilometer: "5.50", totalCost: "67.93" },
        "cutoff-over-paid": { ratePerKilometer: "11.00", totalCost: "135.74" },
        "cutoff-over-unpaid-round": {
          ratePerKilometer: "11.00",
          totalCost: "0.66",
        },
        "after-in-round-paid": { ratePerKilometer: "5.50", totalCost: "0.11" },
        "after-over-unpaid": { ratePerKilometer: "11.00", totalCost: "550.00" },
        "future-in": { ratePerKilometer: "5.50", totalCost: "18.32" },
      };
      const after = (
        await client.query('SELECT * FROM "DriveCost" ORDER BY id')
      ).rows;
      expect(after).toEqual(
        before.map((record) => ({ ...record, ...changedCosts[record.id] })),
      );

      // Reapplying the migration never increases already recalculated costs.
      await client.query(migration(rateMigration));
      expect(
        (await client.query('SELECT * FROM "DriveCost" ORDER BY id')).rows,
      ).toEqual(after);

      // Backdated entries keep the old rates; the boundary uses the new rates.
      await client.query(`
        INSERT INTO "DriveCost" (id,date,"destinationFrom","destinationTo",
          kilometers,"rateType","ratePerKilometer","totalCost","isRoundTrip",
          "createdById","updatedAt") VALUES
          ('new-before-in','2026-09-25','Office','Warehouse',0.01,'IN_TIME',5.00,0.05,false,'admin',now()),
          ('new-before-over','2026-09-25','Office','Warehouse',0.01,'OVER_TIME',10.00,0.20,true,'admin',now()),
          ('new-cutoff-in','2026-09-26','Office','Warehouse',0.01,'IN_TIME',5.50,0.06,false,'admin',now()),
          ('new-cutoff-over','2026-09-26','Office','Warehouse',0.01,'OVER_TIME',11.00,0.22,true,'admin',now());
      `);

      for (const invalid of [
        {
          id: "before-in",
          set: '"ratePerKilometer"=5.50,"totalCost"=67.93',
          constraint: "DriveCost_rate_valid",
        },
        {
          id: "before-over",
          set: '"ratePerKilometer"=11.00,"totalCost"=0.66',
          constraint: "DriveCost_rate_valid",
        },
        {
          id: "cutoff-in-unpaid",
          set: '"ratePerKilometer"=5.00,"totalCost"=0.05',
          constraint: "DriveCost_rate_valid",
        },
        {
          id: "cutoff-over-paid",
          set: '"ratePerKilometer"=10.00,"totalCost"=123.40',
          constraint: "DriveCost_rate_valid",
        },
        {
          id: "cutoff-in-paid",
          set: "date='2026-09-25'",
          constraint: "DriveCost_rate_valid",
        },
        {
          id: "before-in",
          set: "date='2026-09-26'",
          constraint: "DriveCost_rate_valid",
        },
        {
          id: "cutoff-in-unpaid",
          set: '"totalCost"=0.05',
          constraint: "DriveCost_total_valid",
        },
        {
          id: "after-in-round-paid",
          set: '"totalCost"=0.12',
          constraint: "DriveCost_total_valid",
        },
        {
          id: "cutoff-over-unpaid-round",
          set: '"totalCost"=0.33',
          constraint: "DriveCost_total_valid",
        },
      ]) {
        await client.query("SAVEPOINT invalid_drive_cost_rate");
        await expect(
          client.query(`UPDATE "DriveCost" SET ${invalid.set} WHERE id=$1`, [
            invalid.id,
          ]),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: invalid.constraint,
        });
        await client.query("ROLLBACK TO SAVEPOINT invalid_drive_cost_rate");
      }
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});
