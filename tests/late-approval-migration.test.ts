import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { calculateOvertime } from "@/modules/shifts/calculations";

const database = process.env.TEST_DATABASE_URL;

describe.skipIf(!database)(
  "late approval migration on historical attendance",
  () => {
    it("recalculates known overtime without rewriting punches or guessing unknown schedules", async () => {
      if (!database || !new URL(database).pathname.includes("test"))
        throw new Error("Migration tests require a disposable test database");
      const client = new Client({ connectionString: database });
      const schema = `late_approval_${randomUUID().replaceAll("-", "")}`;
      const migration = (name: string) =>
        readFileSync(
          new URL(
            `../prisma/migrations/${name}/migration.sql`,
            import.meta.url,
          ),
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
        ])
          await client.query(migration(name));
        await client.query(`
        INSERT INTO "User" (id,email,"updatedAt") VALUES ('user','late-migration@example.test',now());
        INSERT INTO "Office" (id,name,address,latitude,longitude,"updatedAt")
          VALUES ('office','Test','Test',0,0,now());
        INSERT INTO "Shift" (id,name,"startTime","endTime","updatedAt")
          VALUES ('shift','Day','08:30','17:00',now());
        INSERT INTO "Employee" (id,"employeeCode","userId","officeId","updatedAt")
          VALUES ('employee','LATE','user','office',now());
        INSERT INTO "Attendance" (id,"employeeId","officeId","shiftId","attendanceDate",
          "checkInAt","checkOutAt","scheduledEndAt",status,"lateMinutes","workedMinutes","overtimeMinutes","updatedAt") VALUES
          ('equal','employee','office','shift','2026-09-01','2026-09-01 09:00','2026-09-01 17:30','2026-09-01 17:00','LATE',30,510,30,'2026-09-01 17:30'),
          ('extra','employee','office','shift','2026-09-02','2026-09-02 09:00','2026-09-02 18:00','2026-09-02 17:00','LATE',30,540,60,'2026-09-02 18:00'),
          ('short','employee','office','shift','2026-09-03','2026-09-03 08:45','2026-09-03 17:10','2026-09-03 17:00','LATE',15,505,10,'2026-09-03 17:10'),
          ('on-time','employee','office','shift','2026-09-04','2026-09-04 08:30','2026-09-04 17:30','2026-09-04 17:00','PRESENT',0,540,30,'2026-09-04 17:30'),
          ('unknown','employee','office','shift','2026-09-05','2026-09-05 09:00','2026-09-05 17:30',NULL,'LATE',30,510,NULL,'2026-09-05 17:30'),
          ('open','employee','office','shift','2026-09-06','2026-09-06 09:00',NULL,'2026-09-06 17:00','LATE',30,0,0,'2026-09-06 09:00'),
          ('fractional','employee','office','shift','2026-09-07','2026-09-07 09:00:01','2026-09-07 17:32:59','2026-09-07 17:00','LATE',31,512,32,'2026-09-07 17:32:59');
      `);
        const before = (
          await client.query('SELECT * FROM "Attendance" ORDER BY id')
        ).rows;
        await client.query(migration("20260926120000_late_approval"));
        const expected = {
          equal: 0,
          extra: 30,
          short: 0,
          "on-time": 30,
          unknown: null,
          open: 0,
          fractional: 1,
        };
        const after = (
          await client.query('SELECT * FROM "Attendance" ORDER BY id')
        ).rows;
        expect(after).toEqual(
          before.map((record) => ({
            ...record,
            scheduledStartAt: null,
            overtimeMinutes: expected[record.id as keyof typeof expected],
          })),
        );
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
        expect(
          (
            await client.query(
              'SELECT count(*)::int AS count FROM "LateApprovalRequest"',
            )
          ).rows[0].count,
        ).toBe(0);
        await client.query(`INSERT INTO "LateApprovalRequest" (id,"attendanceId","checkInAt","lateMinutes",reason)
        VALUES ('request','equal','2026-09-01 09:00',30,'Legacy reason');`);
        await client.query("SAVEPOINT duplicate_request");
        await expect(
          client.query(`INSERT INTO "LateApprovalRequest" (id,"attendanceId","checkInAt","lateMinutes",reason)
        VALUES ('duplicate','equal','2026-09-01 09:00',30,'Duplicate');`),
        ).rejects.toMatchObject({
          code: "23505",
          constraint: "LateApprovalRequest_attendanceId_key",
        });
        await client.query("ROLLBACK TO SAVEPOINT duplicate_request");
        await expect(
          client.query(
            `UPDATE "LateApprovalRequest" SET status='APPROVED' WHERE id='request'`,
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "LateApprovalRequest_review_valid",
        });
        await client.query("ROLLBACK TO SAVEPOINT duplicate_request");
        await expect(
          client.query(
            'UPDATE "LateApprovalRequest" SET "lateMinutes"=0 WHERE id=$1',
            ["request"],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "LateApprovalRequest_late_positive",
        });
      } finally {
        await client.query("ROLLBACK");
        await client.end();
      }
    });
  },
);
