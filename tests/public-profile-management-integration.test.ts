import { randomUUID } from "node:crypto";
import type { Role } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createEmployee, updateEmployee } from "@/modules/employees/service";
import { updateRecord } from "@/modules/management/service";
import {
  getManagedPublicProfile,
  updatePublicProfile,
} from "@/modules/public-profile/management";
import type { Actor } from "@/modules/management/permissions";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "public profile management against PostgreSQL",
  () => {
    let superAdmin: Actor;
    let officeId: string;

    async function user(role: Role = "EMPLOYEE") {
      return db.user.create({
        data: {
          name: "Original name",
          email: `public-edit-${randomUUID()}@example.test`,
          role,
          passwordHash: "private-test-password-hash",
        },
        select: { id: true, role: true },
      });
    }

    async function employee() {
      const identity = await user();
      return db.employee.create({
        data: { userId: identity.id, employeeCode: randomUUID(), officeId },
      });
    }

    beforeAll(async () => {
      if (!databaseUrl || !new URL(databaseUrl).pathname.includes("test"))
        throw new Error("Public profile tests require a test database");
      Object.assign(process.env, {
        DATABASE_URL: databaseUrl,
        NODE_ENV: "test",
      });
      superAdmin = await user("SUPER_ADMIN");
      officeId = (
        await db.office.create({
          data: {
            name: `Profile ${randomUUID()}`,
            address: "Test office",
            latitude: 0,
            longitude: 0,
          },
        })
      ).id;
    });

    afterAll(async () => db.$disconnect());

    it.each(["EMPLOYEE", "ADMIN", "SUPER_ADMIN"] as const)(
      "lets an active Super Admin update %s profiles without changing account access",
      async (role) => {
        const target = await user(role);
        const fields = {
          name: "  Public person  ",
          designation: "Engineer",
          phone: "+880 1700 123456",
          bloodGroup: "AB+",
          publicDepartment: "Operations",
          homeAddress: "123 Example Road, Dhaka",
          dateOfBirth: "2000-02-29",
        };
        const result = await updatePublicProfile(superAdmin, target.id, fields);
        const expected = { id: target.id, ...fields, name: "Public person" };
        expect(result).toEqual(expected);
        expect(await getManagedPublicProfile(superAdmin, target.id)).toEqual(
          expected,
        );
        const persisted = await db.user.findUniqueOrThrow({
          where: { id: target.id },
        });
        expect(persisted.dateOfBirth?.toISOString()).toBe(
          "2000-02-29T00:00:00.000Z",
        );
        expect(persisted.role).toBe(role);
        expect(persisted.status).toBe("ACTIVE");
        expect(persisted.passwordHash).toBe("private-test-password-hash");
        expect(result).not.toHaveProperty("email");
        expect(result).not.toHaveProperty("passwordHash");
        const audit = await db.auditLog.findFirstOrThrow({
          where: {
            actorId: superAdmin.id,
            resourceId: target.id,
            action: "PUBLIC_PROFILE_UPDATED",
          },
        });
        expect(audit.previousState).toBeNull();
        expect(audit.newState).toEqual({ changedFields: Object.keys(fields) });
        expect(JSON.stringify(audit)).not.toMatch(
          /Public person|123 Example|1700 123456|2000-02-29|private-test/,
        );
      },
    );

    it("clears optional information without inventing placeholder values", async () => {
      const target = await user();
      await updatePublicProfile(superAdmin, target.id, {
        name: "Name",
        phone: "1234",
        dateOfBirth: "2000-01-01",
      });
      expect(
        await updatePublicProfile(superAdmin, target.id, {
          name: "Name",
          phone: " ",
          dateOfBirth: null,
        }),
      ).toMatchObject({ phone: null, dateOfBirth: null });
    });

    it.each(["ADMIN", "MANAGE_DRIVER", "EMPLOYEE"] as const)(
      "rejects %s access through both service entry points",
      async (role) => {
        const actor = await user(role);
        const target = await user();
        await expect(
          getManagedPublicProfile(actor, target.id),
        ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
        await expect(
          updatePublicProfile(actor, target.id, { name: "Unauthorized" }),
        ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
        expect(
          (await db.user.findUniqueOrThrow({ where: { id: target.id } })).name,
        ).toBe("Original name");
        expect(
          await db.auditLog.count({ where: { resourceId: target.id } }),
        ).toBe(0);
      },
    );

    it.each(["ADMIN", "INACTIVE", "SUSPENDED", "MISSING"] as const)(
      "rejects stale Super Admin authority after %s",
      async (state) => {
        const actor = await user("SUPER_ADMIN");
        const target = await user();
        if (state === "MISSING")
          await db.user.delete({ where: { id: actor.id } });
        else
          await db.user.update({
            where: { id: actor.id },
            data: state === "ADMIN" ? { role: state } : { status: state },
          });
        await expect(
          getManagedPublicProfile(actor, target.id),
        ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
        await expect(
          updatePublicProfile(actor, target.id, { name: "Unauthorized" }),
        ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
        expect(
          (await db.user.findUniqueOrThrow({ where: { id: target.id } })).name,
        ).toBe("Original name");
        expect(
          await db.auditLog.count({ where: { resourceId: target.id } }),
        ).toBe(0);
      },
    );

    it("returns not found for a deleted profile without leaving an audit", async () => {
      const missing = randomUUID();
      await expect(
        getManagedPublicProfile(superAdmin, missing),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      await expect(
        updatePublicProfile(superAdmin, missing, { name: "Missing" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      expect(await db.auditLog.count({ where: { resourceId: missing } })).toBe(
        0,
      );
    });

    it("blocks a regular Admin name change through both employee service and generic management", async () => {
      const admin = await user("ADMIN");
      const target = await employee();
      await expect(
        updateEmployee(admin, target.id, { name: "Unauthorized" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
      await expect(
        updateRecord(admin, "employees", target.id, { name: "Unauthorized" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: target.userId } }))
          .name,
      ).toBe("Original name");
      expect(
        await db.auditLog.count({ where: { resourceId: target.id } }),
      ).toBe(0);
    });

    it.each(["ADMIN", "INACTIVE", "SUSPENDED", "MISSING"] as const)(
      "blocks a stale Super Admin employee name change after %s",
      async (state) => {
        const actor = await user("SUPER_ADMIN");
        const target = await employee();
        if (state === "MISSING")
          await db.user.delete({ where: { id: actor.id } });
        else
          await db.user.update({
            where: { id: actor.id },
            data: state === "ADMIN" ? { role: state } : { status: state },
          });
        await expect(
          updateEmployee(actor, target.id, { name: "Unauthorized" }),
        ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
        expect(
          (await db.user.findUniqueOrThrow({ where: { id: target.userId } }))
            .name,
        ).toBe("Original name");
      },
    );

    it("retains Admin workplace editing when the submitted public name is unchanged", async () => {
      const admin = await user("ADMIN");
      const target = await employee();
      const department = await db.department.create({
        data: { name: `Work ${randomUUID()}` },
      });
      await updatePublicProfile(superAdmin, target.userId, {
        name: "Original name",
        publicDepartment: "Public department",
      });
      await expect(
        updateEmployee(admin, target.id, {
          name: "Original name",
          departmentId: department.id,
        }),
      ).resolves.toMatchObject({ departmentId: department.id });
      expect(
        (await getManagedPublicProfile(superAdmin, target.userId))
          .publicDepartment,
      ).toBe("Public department");
      await updateEmployee(superAdmin, target.id, { name: "Super Admin name" });
      expect(
        (await getManagedPublicProfile(superAdmin, target.userId)).name,
      ).toBe("Super Admin name");
    });

    it("initializes a new employee's public department from their assigned department", async () => {
      const department = await db.department.create({
        data: { name: `New ${randomUUID()}` },
      });
      const id = randomUUID();
      const created = await createEmployee(superAdmin, {
        name: "New employee",
        email: `public-created-${id}@example.test`,
        employeeCode: id,
        officeId,
        departmentId: department.id,
        status: "ACTIVE",
        password: "initial employee passphrase",
        confirmPassword: "initial employee passphrase",
      });
      expect(
        (await getManagedPublicProfile(superAdmin, created.userId))
          .publicDepartment,
      ).toBe(department.name);
    });
  },
);
