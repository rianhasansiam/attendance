import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client } from "pg";

const database = process.env.TEST_DATABASE_URL;
test(
  "additive overtime migration preserves historical facts and enforces request constraints",
  { skip: !database },
  async () => {
    const url = new URL(database!);
    assert.ok(
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        url.pathname.includes("test"),
      "Migration rehearsal requires disposable local PostgreSQL.",
    );
    const client = new Client({ connectionString: database });
    const schema = `overtime_migration_${randomUUID().replaceAll("-", "")}`;
    const directory = new URL("../prisma/migrations/", import.meta.url);
    const target = "20261114000000_overtime_approval";
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const name of (await readdir(directory))
        .filter((name) => /^\d/.test(name) && name < target)
        .sort()) {
        // Keep historical migrations that own BEGIN/COMMIT inside this rehearsal's
        // outer rollback, so SET LOCAL cannot fall back to the public schema.
        const sql = await readFile(
          new URL(`${name}/migration.sql`, directory),
          "utf8",
        );
        await client.query(sql.replace(/^(?:BEGIN|COMMIT);[^\S\r\n]*$/gm, ""));
      }
      await client.query(`
      INSERT INTO "User" (id,name,email,"updatedAt") VALUES ('employee','Historical employee','historical@example.test',NOW()), ('reviewer','Reviewer','reviewer@example.test',NOW());
      INSERT INTO "Office" (id,name,address,latitude,longitude,"updatedAt") VALUES ('office','Historical office','Test fixture',0,0,NOW());
      INSERT INTO "Shift" (id,name,"startTime","endTime","updatedAt") VALUES ('shift','Day','08:30','17:00',NOW());
      INSERT INTO "Employee" (id,"userId","employeeCode","officeId","updatedAt") VALUES ('employee','employee','HIST-1','office',NOW());
      INSERT INTO "Attendance" (id,"employeeId","officeId","shiftId","attendanceDate",status,"checkInAt","checkOutAt","scheduledEndAt","overtimeMinutes","workedMinutes","updatedAt") VALUES
        ('known','employee','office','shift','2026-11-12','PRESENT','2026-11-12 08:30','2026-11-12 18:15','2026-11-12 17:00',75,585,NOW()),
        ('unknown','employee','office','shift','2026-11-13','PRESENT','2026-11-13 08:30','2026-11-13 18:15',NULL,NULL,585,NOW());
    `);
      const before = await client.query(
        'SELECT row_to_json(a) AS record FROM "Attendance" a ORDER BY id',
      );
      await client.query(
        await readFile(new URL(`${target}/migration.sql`, directory), "utf8"),
      );
      const after = await client.query(
        'SELECT row_to_json(a) AS record FROM "Attendance" a ORDER BY id',
      );
      assert.deepEqual(after.rows, before.rows);
      assert.equal(
        (
          await client.query(
            'SELECT count(*)::int AS count FROM "OvertimeRequest"',
          )
        ).rows[0].count,
        0,
      );
      const insert = `INSERT INTO "OvertimeRequest" (id,"attendanceId","checkInAt","scheduledEndAt","checkOutAt","requestedMinutes",reason,"updatedAt") VALUES ($1,'known','2026-11-12 08:30','2026-11-12 17:00','2026-11-12 18:15',$2,$3,NOW())`;
      for (const [minutes, reason] of [
        [59, "Completed important work"],
        [75, "short"],
      ] as const) {
        await client.query("SAVEPOINT invalid_request");
        await assert.rejects(
          client.query(insert, [randomUUID(), minutes, reason]),
          { code: "23514" },
        );
        await client.query("ROLLBACK TO SAVEPOINT invalid_request");
      }
      await client.query(insert, ["request", 75, "Completed important work"]);
      await client.query("SAVEPOINT duplicate_request");
      await assert.rejects(
        client.query(insert, ["duplicate", 75, "Completed important work"]),
        { code: "23505" },
      );
      await client.query("ROLLBACK TO SAVEPOINT duplicate_request");
      await client.query("SAVEPOINT invalid_review");
      await assert.rejects(
        client.query(
          "UPDATE \"OvertimeRequest\" SET status='APPROVED' WHERE id='request'",
        ),
        { code: "23514" },
      );
      await client.query("ROLLBACK TO SAVEPOINT invalid_review");
      await client.query(
        "UPDATE \"OvertimeRequest\" SET status='APPROVED',\"reviewedById\"='reviewer',\"reviewedAt\"=NOW() WHERE id='request'",
      );
      await client.query("DELETE FROM \"User\" WHERE id='reviewer'");
      const reviewed = (
        await client.query(
          'SELECT status,"reviewedById","reviewedAt" FROM "OvertimeRequest" WHERE id=\'request\'',
        )
      ).rows[0];
      assert.equal(reviewed.status, "APPROVED");
      assert.equal(reviewed.reviewedById, null);
      assert.ok(reviewed.reviewedAt);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  },
);
