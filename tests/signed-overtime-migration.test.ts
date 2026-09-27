import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { calculateOvertime } from "@/modules/shifts/calculations";

const database = process.env.TEST_DATABASE_URL;

describe.skipIf(!database)("signed overtime migration", () => {
  it("backfills signed balances without changing punches, late approvals, or unknown schedules", async () => {
    if (!database || !new URL(database).pathname.includes("test"))
      throw new Error("Migration tests require a disposable test database");
    const client = new Client({ connectionString: database });
    const schema = `signed_overtime_${randomUUID().replaceAll("-", "")}`;
    const migration = (name: string) =>
      readFileSync(
        new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url),
        "utf8",
      );
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
        "20260926120000_late_approval",
      ])
        await client.query(migration(name));
      await client.query(`
        INSERT INTO "User" (id,email,"updatedAt") VALUES ('user','signed-overtime@example.test',now());
        INSERT INTO "Office" (id,name,address,latitude,longitude,"updatedAt")
          VALUES ('office','Test','Test',0,0,now());
        INSERT INTO "Shift" (id,name,"startTime","endTime","updatedAt")
          VALUES ('shift','Day','08:30','17:00',now());
        INSERT INTO "Employee" (id,"employeeCode","userId","officeId","updatedAt")
          VALUES ('employee','SIGNED','user','office',now());
        INSERT INTO "Attendance" (id,"employeeId","officeId","shiftId","attendanceDate",
          "checkInAt","checkOutAt","scheduledEndAt",status,"lateMinutes","workedMinutes","overtimeMinutes","updatedAt") VALUES
          ('equal','employee','office','shift','2026-09-01','2026-09-01 09:00','2026-09-01 17:30','2026-09-01 17:00','LATE',30,510,0,'2026-09-01 17:30'),
          ('extra','employee','office','shift','2026-09-02','2026-09-02 09:00','2026-09-02 18:00','2026-09-02 17:00','LATE',30,540,30,'2026-09-02 18:00'),
          ('short','employee','office','shift','2026-09-03','2026-09-03 08:45','2026-09-03 17:10','2026-09-03 17:00','LATE',15,505,0,'2026-09-03 17:10'),
          ('early','employee','office','shift','2026-09-04','2026-09-04 08:30','2026-09-04 16:00','2026-09-04 17:00','PRESENT',0,450,0,'2026-09-04 16:00'),
          ('early-and-late','employee','office','shift','2026-09-05','2026-09-05 09:00','2026-09-05 16:00','2026-09-05 17:00','LATE',30,420,0,'2026-09-05 16:00'),
          ('unknown','employee','office','shift','2026-09-06','2026-09-06 09:00','2026-09-06 16:00',NULL,'LATE',30,420,NULL,'2026-09-06 16:00'),
          ('open','employee','office','shift','2026-09-07','2026-09-07 09:00',NULL,'2026-09-07 17:00','LATE',30,0,0,'2026-09-07 09:00'),
          ('fractional-extra','employee','office','shift','2026-09-08','2026-09-08 09:00:01','2026-09-08 17:32:59','2026-09-08 17:00','LATE',31,512,1,'2026-09-08 17:32:59'),
          ('fractional-short','employee','office','shift','2026-09-09','2026-09-09 08:30','2026-09-09 16:59:59','2026-09-09 17:00','PRESENT',0,509,0,'2026-09-09 16:59:59'),
          ('overnight','employee','office','shift','2026-09-10','2026-09-10 22:00','2026-09-11 05:30','2026-09-11 06:00','PRESENT',0,450,0,'2026-09-11 05:30'),
          ('after-end','employee','office','shift','2026-09-12','2026-09-12 18:00','2026-09-12 18:20','2026-09-12 17:00','LATE',570,20,0,'2026-09-12 18:20'),
          ('absent','employee','office','shift','2026-09-13',NULL,NULL,'2026-09-13 17:00','ABSENT',0,0,0,'2026-09-13 17:00'),
          ('on-time','employee','office','shift','2026-09-14','2026-09-14 08:30','2026-09-14 17:00','2026-09-14 17:00','PRESENT',0,510,0,'2026-09-14 17:00'),
          ('capped-at-worked','employee','office','shift','2026-09-15','2026-09-15 18:00','2026-09-15 19:00','2026-09-15 17:00','PRESENT',0,60,60,'2026-09-15 19:00');
        INSERT INTO "LateApprovalRequest" (id,"attendanceId",status,"checkInAt","lateMinutes",reason,"reviewedById","reviewedAt")
          VALUES ('approved','early-and-late','APPROVED','2026-09-05 09:00',30,'Traffic','user','2026-09-05 10:00');
      `);
      const before = (
        await client.query('SELECT * FROM "Attendance" ORDER BY id')
      ).rows;
      const approvalBefore = (
        await client.query('SELECT * FROM "LateApprovalRequest" ORDER BY id')
      ).rows;
      await client.query(migration("20260927120000_signed_overtime"));
      const expected = {
        equal: 0,
        extra: 30,
        short: -5,
        early: -60,
        "early-and-late": -90,
        unknown: null,
        open: 0,
        "fractional-extra": 1,
        "fractional-short": -1,
        overnight: -30,
        "after-end": -490,
        absent: 0,
        "on-time": 0,
        "capped-at-worked": 60,
      };
      const after = (
        await client.query('SELECT * FROM "Attendance" ORDER BY id')
      ).rows;
      expect(after).toEqual(
        before.map((record) => ({
          ...record,
          overtimeMinutes: expected[record.id as keyof typeof expected],
        })),
      );
      expect(
        (await client.query('SELECT * FROM "LateApprovalRequest" ORDER BY id'))
          .rows,
      ).toEqual(approvalBefore);
      for (const record of after.filter((record) => record.checkOutAt)) {
        expect(record.overtimeMinutes).toBe(
          calculateOvertime(
            record.checkInAt,
            record.checkOutAt,
            record.lateMinutes,
            record.scheduledEndAt,
          ).overtimeMinutes,
        );
      }

      // Reapplying the calculation preserves the same historical balances.
      await client.query(migration("20260927120000_signed_overtime"));
      expect(
        (await client.query('SELECT * FROM "Attendance" ORDER BY id')).rows,
      ).toEqual(after);

      for (const invalid of [
        { id: "early", set: '"overtimeMinutes" = 451' },
        { id: "early", set: '"scheduledEndAt" = NULL' },
        { id: "early", set: '"checkOutAt" = NULL' },
        { id: "early", set: '"checkInAt" = NULL, "checkOutAt" = NULL' },
        { id: "open", set: '"overtimeMinutes" = -1' },
        { id: "unknown", set: '"overtimeMinutes" = -1' },
      ]) {
        await client.query("SAVEPOINT invalid_overtime");
        await expect(
          client.query(`UPDATE "Attendance" SET ${invalid.set} WHERE id=$1`, [
            invalid.id,
          ]),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "Attendance_overtime_valid",
        });
        await client.query("ROLLBACK TO SAVEPOINT invalid_overtime");
      }
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});
