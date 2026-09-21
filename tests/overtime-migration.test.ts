import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const database = process.env.TEST_DATABASE_URL;
const integration = database ? describe : describe.skip;

integration("overtime migration on existing attendance", () => {
  it("preserves legacy punches, distinguishes unknown overtime, and enforces valid durations", async () => {
    if (!database || !new URL(database).pathname.includes("test"))
      throw new Error("Migration tests require an isolated test database");
    const client = new Client({ connectionString: database });
    const schema = `overtime_${randomUUID().replaceAll("-", "")}`;
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      for (const migration of [
        "20260919000000_initial",
        "20260920000000_attendance_recent_index",
        "20260921000000_attendance_late_reason",
      ]) {
        await client.query(
          readFileSync(
            new URL(
              `../prisma/migrations/${migration}/migration.sql`,
              import.meta.url,
            ),
            "utf8",
          ),
        );
      }
      await client.query(`
        INSERT INTO "User" (id,email,"updatedAt") VALUES ('user','overtime@example.test',now());
        INSERT INTO "Office" (id,name,address,latitude,longitude,"updatedAt")
          VALUES ('office','Test','Test',0,0,now());
        INSERT INTO "Shift" (id,name,"startTime","endTime","updatedAt")
          VALUES ('shift','Night','22:00','06:00',now());
        INSERT INTO "Employee" (id,"employeeCode","userId","officeId","updatedAt")
          VALUES ('employee','OT','user','office',now());
        INSERT INTO "Attendance" (id,"employeeId","officeId","shiftId","attendanceDate",
          "checkInAt","checkOutAt",status,"workedMinutes","updatedAt") VALUES
          ('closed','employee','office','shift','2026-09-18','2026-09-18 22:00',
            '2026-09-19 07:30','PRESENT',570,'2026-09-19 07:30'),
          ('open','employee','office','shift','2026-09-19','2026-09-19 22:00',
            NULL,'PRESENT',0,'2026-09-19 22:00'),
          ('absent','employee','office','shift','2026-09-17',NULL,
            NULL,'ABSENT',0,'2026-09-18 06:00');
      `);
      const before = (
        await client.query('SELECT * FROM "Attendance" ORDER BY id')
      ).rows;
      await client.query(
        readFileSync(
          new URL(
            "../prisma/migrations/20260922000000_attendance_overtime/migration.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const after = (
        await client.query('SELECT * FROM "Attendance" ORDER BY id')
      ).rows;
      expect(after).toEqual(
        before.map((record) => ({
          ...record,
          scheduledEndAt: null,
          overtimeMinutes: record.checkOutAt ? null : 0,
        })),
      );

      await client.query(`
        UPDATE "Attendance" SET "checkOutAt"='2026-09-20 07:30',
          "scheduledEndAt"='2026-09-20 06:00',"workedMinutes"=570,"overtimeMinutes"=90
        WHERE id='open';
      `);
      expect(
        (
          await client.query(
            'SELECT "overtimeMinutes" FROM "Attendance" WHERE id=$1',
            ["open"],
          )
        ).rows[0].overtimeMinutes,
      ).toBe(90);
      for (const invalid of [
        '"overtimeMinutes" = -1',
        '"overtimeMinutes" = 571',
        '"scheduledEndAt" = NULL',
        '"checkOutAt" = NULL',
      ]) {
        await client.query("SAVEPOINT invalid_overtime");
        await expect(
          client.query(`UPDATE "Attendance" SET ${invalid} WHERE id='open'`),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "Attendance_overtime_valid",
        });
        await client.query("ROLLBACK TO SAVEPOINT invalid_overtime");
      }
      const indexes = (
        await client.query(
          "SELECT indexname FROM pg_indexes WHERE schemaname=$1",
          [schema],
        )
      ).rows.map((row) => row.indexname);
      expect(indexes).toContain("Attendance_one_open_per_employee");
      expect(indexes).toContain("Attendance_employeeId_attendanceDate_key");
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});
