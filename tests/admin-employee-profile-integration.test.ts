import { randomUUID } from "node:crypto";
import type { Role } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createEmployee,
  createEmployeeProfile,
  getOwnEmployeeProfile,
  updateEmployee,
} from "@/modules/employees/service";
import { listRecords } from "@/modules/management/service";
import type { Actor } from "@/modules/management/permissions";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "administrator employee profiles against PostgreSQL",
  () => {
    const marker = `admin-profile-${randomUUID()}`;
    let superAdmin: Actor;
    let officeId: string;
    let departmentId: string;

    async function identity(role: Role) {
      const id = randomUUID();
      const user = await db.user.create({
        data: {
          name: `${marker} ${role}`,
          email: `${id}@example.test`,
          role,
          designation: "Existing designation",
          publicDepartment: "Existing public department",
          passwordHash: `private-password-${id}`,
          googleAccountId: `private-google-${id}`,
          emailVerified: new Date("2026-09-01T00:00:00Z"),
          accounts: {
            create: {
              type: "oidc",
              provider: "google",
              providerAccountId: id,
              access_token: "private-access-token",
            },
          },
          sessions: {
            create: {
              sessionToken: id,
              expires: new Date(Date.now() + 3_600_000),
            },
          },
        },
      });
      return user;
    }

    function input() {
      return { employeeCode: randomUUID(), officeId, departmentId };
    }

    async function snapshot(id: string) {
      return db.user.findUniqueOrThrow({
        where: { id },
        include: { accounts: true, sessions: true },
      });
    }

    beforeAll(async () => {
      if (!databaseUrl || !new URL(databaseUrl).pathname.includes("test"))
        throw new Error(
          "Administrator employee profile tests require a test database",
        );
      Object.assign(process.env, {
        DATABASE_URL: databaseUrl,
        NODE_ENV: "test",
      });
      superAdmin = await identity("SUPER_ADMIN");
      officeId = (
        await db.office.create({
          data: {
            name: marker,
            address: "Administrator profile office",
            latitude: 0,
            longitude: 0,
          },
        })
      ).id;
      departmentId = (await db.department.create({ data: { name: marker } }))
        .id;
    });

    // Audit history is immutable; the disposable database owns fixture cleanup.
    afterAll(async () => db.$disconnect());

    it.each(["ADMIN", "SUPER_ADMIN"] as const)(
      "attaches a %s profile while preserving the complete identity and sign-in methods",
      async (role) => {
        const user = await identity(role);
        const previous = await snapshot(user.id);
        const payload = input();
        const profile = await createEmployeeProfile(
          superAdmin,
          user.id,
          payload,
        );
        expect(profile).toMatchObject({
          ...payload,
          userId: user.id,
          user: { id: user.id, role, status: "ACTIVE", email: user.email },
        });
        expect(await snapshot(user.id)).toEqual(previous);
        expect(await db.user.count({ where: { email: user.email } })).toBe(1);
        expect(await db.employee.count({ where: { userId: user.id } })).toBe(1);
        expect(
          await getOwnEmployeeProfile({ id: user.id, employee: profile }),
        ).toMatchObject({ id: profile.id, employeeCode: payload.employeeCode });
        expect(
          await listRecords(superAdmin, "employees", {
            q: user.email,
            page: 1,
            pageSize: 20,
          }),
        ).toMatchObject({
          total: 1,
          items: [
            { id: profile.id, userId: user.id, hasEmployeeProfile: true },
          ],
        });
        const audit = await db.auditLog.findFirstOrThrow({
          where: {
            actorId: superAdmin.id,
            resourceId: profile.id,
            action: "EMPLOYEE_PROFILE_CREATED",
          },
        });
        for (const result of [profile, audit.previousState, audit.newState]) {
          expect(JSON.stringify(result)).not.toMatch(
            /passwordHash|googleAccountId|access_token|sessionToken|private-password|private-google/,
          );
        }
      },
    );

    it("lets Super Admin attach their own employee profile without losing access", async () => {
      const previous = await snapshot(superAdmin.id);
      const profile = await createEmployeeProfile(
        superAdmin,
        superAdmin.id,
        input(),
      );
      expect(profile.user).toMatchObject({
        id: superAdmin.id,
        role: "SUPER_ADMIN",
      });
      expect(await snapshot(superAdmin.id)).toEqual(previous);
      expect(
        await getOwnEmployeeProfile({ ...superAdmin, employee: profile }),
      ).toMatchObject({
        id: profile.id,
        userId: superAdmin.id,
      });
    });

    it.each(["ADMIN", "SUPER_ADMIN"] as const)(
      "creates a new %s account with an employee profile and no required password",
      async (role) => {
        const email = `${randomUUID()}@example.test`;
        const profile = await createEmployee(superAdmin, {
          ...input(),
          name: `New ${role}`,
          email,
          role,
          status: "ACTIVE",
        });
        const user = await db.user.findUniqueOrThrow({
          where: { id: profile.userId },
        });
        expect(user).toMatchObject({
          email,
          role,
          passwordHash: null,
          googleAccountId: null,
        });
        expect(profile.userId).toBe(user.id);
        expect(await db.employee.count({ where: { userId: user.id } })).toBe(1);
      },
    );

    it("rejects an existing profile without replacing its ID or assignments", async () => {
      const user = await identity("ADMIN");
      const profile = await createEmployeeProfile(superAdmin, user.id, input());
      await expect(
        createEmployeeProfile(superAdmin, user.id, input()),
      ).rejects.toMatchObject({
        code: "EMPLOYEE_PROFILE_EXISTS",
        status: 409,
      });
      expect(
        await db.employee.findUniqueOrThrow({ where: { userId: user.id } }),
      ).toMatchObject({
        id: profile.id,
        employeeCode: profile.employeeCode,
        officeId,
        departmentId,
      });
      expect(
        await db.auditLog.count({
          where: { resourceId: profile.id, action: "EMPLOYEE_PROFILE_CREATED" },
        }),
      ).toBe(1);
    });

    it("resolves simultaneous attachments to one profile and one audit entry", async () => {
      const user = await identity("ADMIN");
      const results = await Promise.allSettled([
        createEmployeeProfile(superAdmin, user.id, input()),
        createEmployeeProfile(superAdmin, user.id, input()),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({ reason: { status: 409 } });
      const profiles = await db.employee.findMany({
        where: { userId: user.id },
      });
      expect(profiles).toHaveLength(1);
      expect(
        await db.auditLog.count({
          where: {
            resourceId: profiles[0].id,
            action: "EMPLOYEE_PROFILE_CREATED",
          },
        }),
      ).toBe(1);
    });

    it("rejects a duplicate employee ID without changing the target identity", async () => {
      const original = await createEmployeeProfile(
        superAdmin,
        (await identity("ADMIN")).id,
        input(),
      );
      const target = await identity("SUPER_ADMIN");
      const previous = await snapshot(target.id);
      await expect(
        createEmployeeProfile(superAdmin, target.id, {
          ...input(),
          employeeCode: original.employeeCode,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
      expect(await db.employee.count({ where: { userId: target.id } })).toBe(0);
      expect(await snapshot(target.id)).toEqual(previous);
    });

    it.each(["office", "department"] as const)(
      "rejects an inactive %s assignment without creating a profile",
      async (kind) => {
        const user = await identity("ADMIN");
        const payload = input();
        if (kind === "office") {
          const office = await db.office.create({
            data: {
              name: `${marker} inactive`,
              address: "Inactive",
              latitude: 0,
              longitude: 0,
              active: false,
            },
          });
          payload.officeId = office.id;
        } else {
          const department = await db.department.create({
            data: { name: `${marker} inactive`, active: false },
          });
          payload.departmentId = department.id;
        }
        await expect(
          createEmployeeProfile(superAdmin, user.id, payload),
        ).rejects.toMatchObject({
          code:
            kind === "office" ? "OFFICE_UNAVAILABLE" : "DEPARTMENT_UNAVAILABLE",
          status: 400,
        });
        expect(await db.employee.count({ where: { userId: user.id } })).toBe(0);
      },
    );

    it.each(["ADMIN", "EMPLOYEE", "MANAGE_DRIVER"] as const)(
      "denies %s even when attaching their own profile",
      async (role) => {
        const user = await identity(role);
        await expect(
          createEmployeeProfile(user, user.id, input()),
        ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
        expect(await db.employee.count({ where: { userId: user.id } })).toBe(0);
      },
    );

    it.each(["demoted", "suspended", "deleted"] as const)(
      "rejects a %s actor whose claimed Super Admin authorization is stale",
      async (change) => {
        const actor = await identity("SUPER_ADMIN");
        const target = await identity("ADMIN");
        if (change === "deleted")
          await db.user.delete({ where: { id: actor.id } });
        else
          await db.user.update({
            where: { id: actor.id },
            data:
              change === "demoted"
                ? { role: "ADMIN" }
                : { status: "SUSPENDED" },
          });
        await expect(
          createEmployeeProfile(actor, target.id, input()),
        ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
        expect(await db.employee.count({ where: { userId: target.id } })).toBe(
          0,
        );
      },
    );

    it("rejects identity or access changes in the attachment payload", async () => {
      const user = await identity("ADMIN");
      const payload = {
        ...input(),
        role: "EMPLOYEE",
        email: "replacement@example.test",
        password: "replacement passphrase",
      };
      await expect(
        createEmployeeProfile(superAdmin, user.id, payload),
      ).rejects.toHaveProperty("name", "ZodError");
      expect(await db.employee.count({ where: { userId: user.id } })).toBe(0);
      expect(
        await db.user.findUniqueOrThrow({ where: { id: user.id } }),
      ).toEqual(user);
    });

    it("keeps administrator role changes outside employment editing", async () => {
      const user = await identity("ADMIN");
      const profile = await createEmployeeProfile(superAdmin, user.id, input());
      const employeeCode = randomUUID();
      await expect(
        updateEmployee(superAdmin, profile.id, { employeeCode }),
      ).resolves.toMatchObject({
        employeeCode,
        user: { id: user.id, role: "ADMIN" },
      });
      await expect(
        updateEmployee(superAdmin, profile.id, { role: "EMPLOYEE" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
      await expect(
        updateEmployee(user, profile.id, { employeeCode: randomUUID() }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    });
  },
);
