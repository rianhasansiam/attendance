import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { Client } from "pg";

const database = process.env.TEST_DATABASE_URL;

test(
  "Work Report migration preserves existing data and enforces immutable identity, author-only writes and retained soft deletion",
  { skip: !database },
  async () => {
    const url = new URL(database!);
    assert.ok(
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        url.pathname.includes("test"),
      "Use an explicitly disposable local test database.",
    );
    const client = new Client({ connectionString: database });
    const schema = `work_report_migration_${randomUUID().replaceAll("-", "")}`;
    const directory = new URL("../prisma/migrations/", import.meta.url);
    const target = "20261122140000_work_report";
    const apply = async (name: string) => {
      const sql = await readFile(
        new URL(`${name}/migration.sql`, directory),
        "utf8",
      );
      await client.query(sql.replace(/^(?:BEGIN|COMMIT);[^\S\r\n]*$/gm, ""));
    };
    const rejectsSql = async (sql: string, code = "23514") => {
      await client.query("SAVEPOINT invalid_report_write");
      await assert.rejects(client.query(sql), { code });
      await client.query("ROLLBACK TO SAVEPOINT invalid_report_write");
    };
    const setActor = (id: string) =>
      client.query("SELECT set_config('app.work_report_actor_id', $1, true)", [
        id,
      ]);
    const insert = (id: string, author: string) =>
      `INSERT INTO "WorkReport" (id,"requestId","createPayloadHash","authorId",content,"workDate","updatedAt") VALUES ('${id}','${randomUUID()}','${"a".repeat(64)}','${author}','Completed the stock report','2026-11-22',NOW())`;
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query("BEGIN");
      for (const name of (await readdir(directory))
        .filter((name) => /^\d/.test(name) && name < target)
        .sort())
        await apply(name);
      await client.query(`INSERT INTO "User" (id,name,email,role,"updatedAt") VALUES ('author','Original author','author@example.test','EMPLOYEE',NOW()), ('super','Super administrator','super@example.test','SUPER_ADMIN',NOW()), ('legacy','Legacy administrator','legacy@example.test','ADMIN',NOW()), ('inactive','Inactive employee','inactive@example.test','EMPLOYEE',NOW()); UPDATE "User" SET status='INACTIVE' WHERE id='inactive';
      INSERT INTO "AuditLog" (id,"actorId",action,resource,"resourceId") VALUES ('old-audit','super','EXISTING_ACTION','User','author');
      INSERT INTO "OfficeWorkTask" (id,"requestId","createPayloadHash",title,"assigneeId","createdById","updatedAt") VALUES ('old-task','${randomUUID()}','${"b".repeat(64)}','Keep existing office work','author','super',NOW())`);
      // Commit only this disposable baseline so the historical Role enum extension
      // is available to PostgreSQL's author trigger. The new migration rolls back.
      await client.query("COMMIT");
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO "User" (id,name,email,role,"updatedAt") VALUES ('manager','Existing manager','manager@example.test','MANAGE_DRIVER',NOW())`,
      );
      const snapshot = async () => [
        await client.query(
          'SELECT row_to_json(u) AS record FROM "User" u ORDER BY id',
        ),
        await client.query(
          'SELECT row_to_json(a) AS record FROM "AuditLog" a ORDER BY id',
        ),
        await client.query(
          'SELECT row_to_json(t) AS record FROM "OfficeWorkTask" t ORDER BY id',
        ),
      ];
      const before = (await snapshot()).map((result) => result.rows);
      await apply(target);
      assert.deepEqual(
        (await snapshot()).map((result) => result.rows),
        before,
      );
      assert.equal(
        (await client.query('SELECT count(*)::int AS count FROM "WorkReport"'))
          .rows[0].count,
        0,
      );
      await rejectsSql(insert("no-actor", "author"), "42501");
      for (const actor of ["legacy", "inactive"]) {
        await setActor(actor);
        await rejectsSql(insert(`denied-${actor}`, actor), "42501");
      }
      await setActor("author");
      await rejectsSql(insert("forged-author", "super"), "42501");
      await client.query(insert("report", "author"));
      await client.query(insert("second-report", "author"));
      assert.equal(
        (
          await client.query(
            'SELECT count(*)::int AS count FROM "WorkReport" WHERE "authorId"=\'author\' AND "workDate"=\'2026-11-22\'',
          )
        ).rows[0].count,
        2,
      );
      const original = (
        await client.query("SELECT * FROM \"WorkReport\" WHERE id='report'")
      ).rows[0];
      assert.equal(original.version, 1);
      assert.equal(original.deletedAt, null);
      for (const actor of ["manager", "super"]) {
        await setActor(actor);
        await client.query(insert(`${actor}-report`, actor));
        await rejectsSql(
          `UPDATE "WorkReport" SET content='Unauthorized override',version=2 WHERE id='report'`,
          "42501",
        );
        await rejectsSql(
          `UPDATE "WorkReport" SET "deletedAt"=NOW(),version=2 WHERE id='report'`,
          "42501",
        );
      }
      await setActor("author");
      for (const assignment of [
        `"authorId"='super'`,
        `"workDate"='2026-11-21'`,
        `"createdAt"='2020-01-01'`,
        `"requestId"='${randomUUID()}'`,
        `"createPayloadHash"='${"c".repeat(64)}'`,
        `id='another-id'`,
      ])
        await rejectsSql(
          `UPDATE "WorkReport" SET ${assignment},version=2 WHERE id='report'`,
        );
      await rejectsSql(
        `UPDATE "WorkReport" SET content='Stale edit' WHERE id='report'`,
      );
      await rejectsSql(
        `UPDATE "WorkReport" SET content=' ',version=2 WHERE id='report'`,
      );
      await client.query(
        `UPDATE "WorkReport" SET title='Corrected title',content='Corrected work description',version=2 WHERE id='report'`,
      );
      const edited = (
        await client.query("SELECT * FROM \"WorkReport\" WHERE id='report'")
      ).rows[0];
      assert.equal(edited.authorId, original.authorId);
      assert.deepEqual(edited.workDate, original.workDate);
      assert.deepEqual(edited.createdAt, original.createdAt);
      await client.query(
        `UPDATE "WorkReport" SET "deletedAt"=NOW(),version=3 WHERE id='report'`,
      );
      await rejectsSql(
        `UPDATE "WorkReport" SET content='Deleted edit',version=4 WHERE id='report'`,
      );
      await rejectsSql(
        `UPDATE "WorkReport" SET "deletedAt"=NULL,version=4 WHERE id='report'`,
      );
      await rejectsSql(`DELETE FROM "WorkReport" WHERE id='report'`);
      assert.ok(
        (
          await client.query(
            'SELECT "deletedAt" FROM "WorkReport" WHERE id=\'report\'',
          )
        ).rows[0].deletedAt,
      );
    } finally {
      await client.query("ROLLBACK");
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  },
);
