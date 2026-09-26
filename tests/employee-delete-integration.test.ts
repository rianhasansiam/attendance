import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createEmployee, deleteEmployee } from "@/modules/employees/service";
import type { Actor } from "@/modules/management/permissions";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "permanent employee deletion in PostgreSQL",
  () => {
    let actor: Actor;
    let officeId: string;

    beforeAll(async () => {
      process.env.DATABASE_URL = databaseUrl;
      actor = await db.user.create({
        data: {
          email: `delete-admin-${randomUUID()}@example.test`,
          role: "SUPER_ADMIN",
        },
        select: { id: true, role: true },
      });
      officeId = (
        await db.office.create({
          data: {
            name: "Deletion tests",
            address: "Test",
            latitude: 0,
            longitude: 0,
          },
        })
      ).id;
    });

    afterAll(async () => {
      await db.$disconnect();
    });

    async function fixture(status: "ACTIVE" | "INACTIVE" = "ACTIVE") {
      const key = randomUUID();
      const employee = await createEmployee(actor, {
        name: "Deletable employee",
        password: "employee initial passphrase",
        confirmPassword: "employee initial passphrase",
        email: `delete-employee-${key}@example.test`,
        employeeCode: key,
        officeId,
        status,
      });
      const session = await db.session.create({
        data: {
          userId: employee.userId,
          sessionToken: key,
          expires: new Date("2099-01-01"),
        },
      });
      await db.account.create({
        data: {
          userId: employee.userId,
          type: "oauth",
          provider: "google",
          providerAccountId: key,
        },
      });
      await db.passwordResetToken.create({
        data: {
          userId: employee.userId,
          email: employee.user.email,
          tokenHash: key,
          expiresAt: new Date("2099-01-01"),
        },
      });
      await db.webAuthnCredential.create({
        data: {
          employeeId: employee.id,
          name: "Test device",
          credentialId: key,
          publicKey: new Uint8Array([1]),
          deviceType: "singleDevice",
          transports: [],
        },
      });
      await db.webAuthnChallenge.create({
        data: {
          employeeId: employee.id,
          sessionId: session.id,
          challenge: key,
          purpose: "REGISTRATION",
          expiresAt: new Date("2099-01-01"),
        },
      });
      return employee;
    }

    async function accessCounts(employee: { id: string; userId: string }) {
      return Promise.all([
        db.session.count({ where: { userId: employee.userId } }),
        db.account.count({ where: { userId: employee.userId } }),
        db.passwordResetToken.count({ where: { userId: employee.userId } }),
        db.webAuthnCredential.count({ where: { employeeId: employee.id } }),
        db.webAuthnChallenge.count({ where: { employeeId: employee.id } }),
      ]);
    }

    it.each(["ACTIVE", "INACTIVE"] as const)(
      "removes the %s employee, identity and all sign-in data",
      async (status) => {
        const target = await fixture(status);
        expect(await accessCounts(target)).toEqual([1, 1, 1, 1, 1]);

        await expect(deleteEmployee(actor, target.id)).resolves.toEqual({
          id: target.id,
        });

        expect(
          await db.employee.findUnique({ where: { id: target.id } }),
        ).toBeNull();
        expect(
          await db.user.findUnique({ where: { id: target.userId } }),
        ).toBeNull();
        expect(await accessCounts(target)).toEqual([0, 0, 0, 0, 0]);
        expect(
          await db.auditLog.count({
            where: { resourceId: target.id, action: "EMPLOYEE_DELETED" },
          }),
        ).toBe(1);
        await expect(deleteEmployee(actor, target.id)).rejects.toMatchObject({
          code: "NOT_FOUND",
          status: 404,
        });

        // Reuse of both unique fields proves the original records are gone.
        const replacement = await createEmployee(actor, {
          name: "Replacement",
          password: "employee initial passphrase",
          confirmPassword: "employee initial passphrase",
          email: target.user.email,
          employeeCode: target.employeeCode,
          officeId,
          status: "ACTIVE",
        });
        expect(replacement.id).not.toBe(target.id);
        expect(replacement.userId).not.toBe(target.userId);
      },
    );

    it("retains two employees’ same-day history with anonymous identities and unchanged attendance facts", async () => {
      const targets = [await fixture(), await fixture()];
      const unrelated = await fixture();
      const shift = await db.shift.create({
        data: {
          name: "History retention",
          startTime: "09:00",
          endTime: "17:00",
        },
      });
      const records = [];
      for (const target of [...targets, unrelated]) {
        const assignment = await db.employeeShift.create({
          data: {
            employeeId: target.id,
            shiftId: shift.id,
            startDate: new Date("2026-09-01"),
          },
        });
        const attendance = await db.attendance.create({
          data: {
            employeeId: target.id,
            officeId,
            shiftId: shift.id,
            attendanceDate: new Date("2026-09-01"),
            checkInAt: new Date("2026-09-01T09:15:00Z"),
            checkOutAt: new Date("2026-09-01T17:00:00Z"),
            scheduledStartAt: new Date("2026-09-01T09:00:00Z"),
            lateMinutes: 15,
            workedMinutes: 465,
            status: "LATE",
          },
        });
        const event = await db.attendanceEvent.create({
          data: {
            employeeId: target.id,
            attendanceId: attendance.id,
            type: "CHECK_IN",
            metadata: {
              employeeId: target.id,
              employee: {
                id: target.id,
                employeeCode: target.employeeCode,
                user: {
                  id: target.userId,
                  name: target.user.name,
                  email: target.user.email,
                },
              },
              lateMinutes: 15,
            },
          },
        });
        const leave = await db.leave.create({
          data: {
            employeeId: target.id,
            startDate: new Date("2026-10-01"),
            endDate: new Date("2026-10-01"),
            reason: "Retain leave history",
          },
        });
        const approval = await db.lateApprovalRequest.create({
          data: {
            attendanceId: attendance.id,
            checkInAt: attendance.checkInAt!,
            scheduledStartAt: attendance.scheduledStartAt,
            lateMinutes: 15,
            reason: "Retain lateness history",
            status: "APPROVED",
            reviewedById: targets[0].userId,
            reviewedAt: new Date("2026-09-02"),
          },
        });
        const audit = await db.auditLog.create({
          data: {
            actorId: target.userId,
            action: "PASSWORD_CHANGED",
            resource: "User",
            resourceId: target.userId,
            previousState: {
              id: target.userId,
              name: target.user.name,
              email: target.user.email,
            },
          },
        });
        records.push({
          target,
          attendance,
          assignment,
          event,
          leave,
          approval,
          audit,
        });
      }
      for (const target of targets) await deleteEmployee(actor, target.id);

      for (const {
        target,
        attendance,
        assignment,
        event,
        leave,
        approval,
        audit,
      } of records.slice(0, 2)) {
        expect(
          await db.employee.findUnique({ where: { id: target.id } }),
        ).toBeNull();
        expect(
          await db.user.findUnique({ where: { id: target.userId } }),
        ).toBeNull();
        expect(await accessCounts(target)).toEqual([0, 0, 0, 0, 0]);
        expect(
          await db.attendance.findUnique({ where: { id: attendance.id } }),
        ).toMatchObject({
          employeeId: null,
          attendanceDate: attendance.attendanceDate,
          checkInAt: attendance.checkInAt,
          checkOutAt: attendance.checkOutAt,
          workedMinutes: 465,
          lateMinutes: 15,
          status: "LATE",
          officeId,
          shiftId: shift.id,
        });
        expect(
          await db.employeeShift.findUnique({ where: { id: assignment.id } }),
        ).toMatchObject({
          employeeId: null,
          shiftId: shift.id,
          startDate: assignment.startDate,
        });
        expect(
          await db.leave.findUnique({ where: { id: leave.id } }),
        ).toMatchObject({
          employeeId: null,
          startDate: leave.startDate,
          endDate: leave.endDate,
          status: leave.status,
        });
        const retainedEvent = await db.attendanceEvent.findUniqueOrThrow({
          where: { id: event.id },
        });
        expect(retainedEvent).toMatchObject({
          employeeId: null,
          attendanceId: attendance.id,
          type: "CHECK_IN",
          metadata: { employeeId: "deleted info", lateMinutes: 15 },
        });
        expect(JSON.stringify(retainedEvent.metadata)).not.toContain(
          target.user.email,
        );
        expect(JSON.stringify(retainedEvent.metadata)).not.toContain(
          target.employeeCode,
        );
        expect(
          await db.lateApprovalRequest.findUnique({
            where: { id: approval.id },
          }),
        ).toMatchObject({
          attendanceId: attendance.id,
          reviewedById: null,
          reviewedAt: approval.reviewedAt,
          status: "APPROVED",
          lateMinutes: 15,
        });
        const retainedAudit = await db.auditLog.findUniqueOrThrow({
          where: { id: audit.id },
        });
        expect(retainedAudit).toMatchObject({
          actorId: null,
          action: "PASSWORD_CHANGED",
          previousState: {
            id: "deleted info",
            name: "deleted info",
            email: "deleted info",
          },
        });
        const snapshots = await db.auditLog.findMany({
          where: { resourceId: { in: [target.id, target.userId] } },
        });
        for (const snapshot of snapshots) {
          expect(JSON.stringify(snapshot.previousState)).not.toContain(
            target.user.email,
          );
          expect(JSON.stringify(snapshot.newState)).not.toContain(
            target.user.email,
          );
          expect(JSON.stringify(snapshot.previousState)).not.toContain(
            target.employeeCode,
          );
          expect(JSON.stringify(snapshot.newState)).not.toContain(
            target.employeeCode,
          );
        }
        await expect(
          db.attendanceEvent.update({
            where: { id: event.id },
            data: { type: "FORGED" },
          }),
        ).rejects.toThrow();
        await expect(
          db.attendanceEvent.delete({ where: { id: event.id } }),
        ).rejects.toThrow();
      }
      const retained = records[2];
      expect(
        await db.attendance.findUnique({
          where: { id: retained.attendance.id },
        }),
      ).toEqual(retained.attendance);
      expect(
        await db.attendanceEvent.findUnique({
          where: { id: retained.event.id },
        }),
      ).toEqual(retained.event);
      expect(
        await db.auditLog.findUnique({ where: { id: retained.audit.id } }),
      ).toEqual(retained.audit);
      expect(await accessCounts(unrelated)).toEqual([1, 1, 1, 1, 1]);
      expect(
        await db.lateApprovalRequest.findUnique({
          where: { id: retained.approval.id },
        }),
      ).toMatchObject({
        reviewedById: null,
        attendanceId: retained.attendance.id,
        status: "APPROVED",
      });
    });
  },
);
