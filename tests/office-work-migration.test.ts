import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { Client } from "pg";

const database = process.env.TEST_DATABASE_URL;

test(
  "Office Work migration is additive and enforces ownership, lifecycle, archive and history invariants",
  { skip: !database },
  async () => {
    const url = new URL(database!);
    assert.ok(
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        url.pathname.includes("test"),
      "Use an explicitly disposable local test database.",
    );
    const client = new Client({ connectionString: database });
    const schema = `office_work_migration_${randomUUID().replaceAll("-", "")}`;
    const directory = new URL("../prisma/migrations/", import.meta.url);
    const target = "20261121140000_office_work_tracker";
    const apply = async (name: string) => {
      const sql = await readFile(
        new URL(`${name}/migration.sql`, directory),
        "utf8",
      );
      // Keep each migration within the rehearsal's rollback-only schema.
      await client.query(sql.replace(/^(?:BEGIN|COMMIT);[^\S\r\n]*$/gm, ""));
    };
    const rejectsSql = async (sql: string, code = "23514") => {
      await client.query("SAVEPOINT invalid_write");
      await assert.rejects(client.query(sql), { code });
      await client.query("ROLLBACK TO SAVEPOINT invalid_write");
    };
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const name of (await readdir(directory))
        .filter((name) => /^\d/.test(name) && name < target)
        .sort())
        await apply(name);
      await client.query(`INSERT INTO "User" (id,name,email,role,"updatedAt") VALUES ('creator','Original creator','creator@example.test','SUPER_ADMIN',NOW()), ('assignee','Original assignee','assignee@example.test','EMPLOYEE',NOW()), ('replacement','Replacement assignee','replacement@example.test','EMPLOYEE',NOW());
      INSERT INTO "AuditLog" (id,"actorId",action,resource,"resourceId") VALUES ('existing-audit','creator','EXISTING_ACTION','User','assignee')`);
      const beforeUsers = await client.query(
        'SELECT row_to_json(u) AS record FROM "User" u ORDER BY id',
      );
      const beforeAudit = await client.query(
        'SELECT row_to_json(a) AS record FROM "AuditLog" a ORDER BY id',
      );
      await apply(target);
      assert.deepEqual(
        (
          await client.query(
            'SELECT row_to_json(u) AS record FROM "User" u ORDER BY id',
          )
        ).rows,
        beforeUsers.rows,
      );
      assert.deepEqual(
        (
          await client.query(
            'SELECT row_to_json(a) AS record FROM "AuditLog" a ORDER BY id',
          )
        ).rows,
        beforeAudit.rows,
      );
      assert.equal(
        (
          await client.query(
            'SELECT count(*)::int AS count FROM "OfficeWorkTask"',
          )
        ).rows[0].count,
        0,
      );
      await client.query(
        `INSERT INTO "OfficeWorkTask" (id,"requestId","createPayloadHash",title,"assigneeId","createdById","dueDate","updatedAt") VALUES ('task','${randomUUID()}','${"a".repeat(64)}','Prepare report','assignee','creator','2026-11-21',NOW())`,
      );
      const initial = (
        await client.query("SELECT * FROM \"OfficeWorkTask\" WHERE id='task'")
      ).rows[0];
      assert.equal(initial.status, "PENDING");
      assert.equal(initial.priority, "MEDIUM");
      assert.equal(initial.version, 1);
      assert.equal(initial.startedAt, null);
      assert.equal(initial.completedAt, null);
      await rejectsSql(
        `UPDATE "OfficeWorkTask" SET status='DONE', "startedAt"=NOW(),version=2 WHERE id='task'`,
      );
      await rejectsSql(
        `UPDATE "OfficeWorkTask" SET title=' ',version=2 WHERE id='task'`,
      );
      await rejectsSql(
        `UPDATE "OfficeWorkTask" SET "createdById"='assignee',version=2 WHERE id='task'`,
      );
      await rejectsSql(
        `UPDATE "OfficeWorkTask" SET title='Stale version' WHERE id='task'`,
      );
      await rejectsSql(
        `UPDATE "OfficeWorkTask" SET "assigneeId"='missing',version=2 WHERE id='task'`,
        "23503",
      );
      await rejectsSql(`DELETE FROM "OfficeWorkTask" WHERE id='task'`);
      await client.query(
        `UPDATE "OfficeWorkTask" SET status='PROCESSING',"startedAt"=NOW(),version=2 WHERE id='task'`,
      );
      await rejectsSql(
        `UPDATE "OfficeWorkTask" SET "assigneeId"='replacement',version=3 WHERE id='task'`,
      );
      await client.query(
        `UPDATE "OfficeWorkTask" SET "assigneeId"='replacement',status='PENDING',"startedAt"=NULL,"completedAt"=NULL,version=3 WHERE id='task'`,
      );
      assert.equal(
        (
          await client.query(
            'SELECT "createdById" FROM "OfficeWorkTask" WHERE id=\'task\'',
          )
        ).rows[0].createdById,
        "creator",
      );
      await client.query(
        `UPDATE "OfficeWorkTask" SET "archivedAt"=NOW(),version=4 WHERE id='task'`,
      );
      await rejectsSql(
        `UPDATE "OfficeWorkTask" SET title='Archived edit',version=5 WHERE id='task'`,
      );
      await rejectsSql(
        `UPDATE "OfficeWorkTask" SET "archivedAt"=NULL,version=5 WHERE id='task'`,
      );
      await rejectsSql(`DELETE FROM "OfficeWorkTask" WHERE id='task'`);
      await rejectsSql(
        `UPDATE "AuditLog" SET action='TAMPERED' WHERE id='existing-audit'`,
        "P0001",
      );
      await rejectsSql(
        `DELETE FROM "AuditLog" WHERE id='existing-audit'`,
        "P0001",
      );
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  },
);
