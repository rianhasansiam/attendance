import { randomUUID } from "node:crypto";
import type { Role } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { authorizeCredentials } from "@/modules/auth/credentials";
import { verifyPassword } from "@/modules/auth/password";
import { createEmployee, updateEmployee } from "@/modules/employees/service";
import { createRecord } from "@/modules/management/service";
import type { Actor } from "@/modules/management/permissions";

const databaseUrl = process.env.TEST_DATABASE_URL;
const password = "employee initial passphrase";

describe.skipIf(!databaseUrl)(
  "super administrator employee provisioning",
  () => {
    let superAdmin: Actor;
    let officeId: string;

    async function actor(role: Role = "SUPER_ADMIN") {
      return db.user.create({
        data: { email: `provision-actor-${randomUUID()}@example.test`, role },
        select: { id: true, role: true },
      });
    }

    function input() {
      const id = randomUUID();
      return {
        name: "Provisioned employee",
        email: `provision-${id}@example.test`,
        employeeCode: id,
        officeId,
        status: "ACTIVE" as const,
        password,
        confirmPassword: password,
      };
    }

    beforeAll(async () => {
      if (!databaseUrl || !new URL(databaseUrl).pathname.includes("test"))
        throw new Error("Employee provisioning tests require a test database");
      Object.assign(process.env, {
        DATABASE_URL: databaseUrl,
        NODE_ENV: "test",
        AUTH_SECRET: "employee-provisioning-only-secret-at-least-32-characters",
        AUTH_URL: "http://localhost:3000",
        GOOGLE_CLIENT_ID: "test-client",
        GOOGLE_CLIENT_SECRET: "test-secret",
        WEBAUTHN_RP_ID: "localhost",
        WEBAUTHN_ORIGIN: "http://localhost:3000",
        TRUSTED_PROXY_MODE: "none",
      });
      await db.rateLimit.deleteMany({
        where: { key: { startsWith: "password:login:" } },
      });
      superAdmin = await actor();
      officeId = (
        await db.office.create({
          data: {
            name: `Provisioning ${randomUUID()}`,
            address: "Test office",
            latitude: 0,
            longitude: 0,
          },
        })
      ).id;
    });

    afterAll(async () => db.$disconnect());

    it.each(["EMPLOYEE", "MANAGE_DRIVER"] as const)(
      "creates a %s identity with a usable password and no credential disclosure",
      async (role) => {
        const payload = input();
        const created = await createEmployee(superAdmin, {
          ...payload,
          email: `  ${payload.email.toUpperCase()}  `,
          role,
        });
        const user = await db.user.findUniqueOrThrow({
          where: { id: created.userId },
        });
        expect(created.user).toMatchObject({
          id: created.userId,
          email: payload.email,
          role,
          status: "ACTIVE",
        });
        expect(user.passwordHash).toMatch(/^\$argon2id\$/);
        expect(await verifyPassword(user.passwordHash, password)).toBe(true);
        const audit = await db.auditLog.findFirstOrThrow({
          where: {
            resourceId: created.id,
            action: "EMPLOYEE_CREATED",
            actorId: superAdmin.id,
          },
        });
        for (const visible of [created, audit.previousState, audit.newState]) {
          const serialized = JSON.stringify(visible);
          expect(serialized).not.toContain(password);
          expect(serialized).not.toMatch(
            /passwordHash|confirmPassword|argon2id/,
          );
        }
        const request = new Request(
          "http://localhost:3000/api/auth/callback/credentials",
        );
        const authenticated = await authorizeCredentials(
          { email: payload.email, password },
          request,
        );
        expect(authenticated?.user.id).toBe(created.userId);
        expect(
          await authorizeCredentials(
            { email: payload.email, password: "a different password" },
            request,
          ),
        ).toBeNull();
        expect(await db.user.count({ where: { email: payload.email } })).toBe(
          1,
        );
        expect(await db.employee.count({ where: { userId: user.id } })).toBe(1);
        expect(await db.account.count({ where: { userId: user.id } })).toBe(0);
      },
    );

    it.each(["ADMIN", "EMPLOYEE", "MANAGE_DRIVER"] as const)(
      "rejects %s creation through both service entry points without creating records",
      async (role) => {
        const unauthorized = await actor(role);
        const payload = input();
        await expect(
          createEmployee(unauthorized, payload),
        ).rejects.toMatchObject({
          code: "FORBIDDEN",
          status: 403,
        });
        await expect(
          createRecord(unauthorized, "employees", payload),
        ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
        expect(await db.user.count({ where: { email: payload.email } })).toBe(
          0,
        );
        expect(
          await db.employee.count({
            where: { employeeCode: payload.employeeCode },
          }),
        ).toBe(0);
      },
    );

    it.each(["ADMIN", "INACTIVE", "SUSPENDED", "MISSING"] as const)(
      "rejects stale SUPER_ADMIN authority after the persisted account becomes %s",
      async (state) => {
        const stale = await actor();
        if (state === "MISSING")
          await db.user.delete({ where: { id: stale.id } });
        else
          await db.user.update({
            where: { id: stale.id },
            data: state === "ADMIN" ? { role: state } : { status: state },
          });
        const payload = input();
        await expect(createEmployee(stale, payload)).rejects.toMatchObject({
          code: "FORBIDDEN",
          status: 403,
        });
        expect(await db.user.count({ where: { email: payload.email } })).toBe(
          0,
        );
      },
    );

    it("rejects invalid passwords before creating either identity or profile", async () => {
      const payload = input();
      for (const invalid of [
        { password: "short", confirmPassword: "short" },
        { password, confirmPassword: "does not match" },
        { password: "p".repeat(129), confirmPassword: "p".repeat(129) },
      ]) {
        await expect(
          createEmployee(superAdmin, { ...payload, ...invalid }),
        ).rejects.toMatchObject({ name: "ZodError" });
      }
      expect(await db.user.count({ where: { email: payload.email } })).toBe(0);
    });

    it("rolls back the password identity when a duplicate employee code prevents profile creation", async () => {
      const original = await createEmployee(superAdmin, input());
      const payload = { ...input(), employeeCode: original.employeeCode };
      await expect(createEmployee(superAdmin, payload)).rejects.toMatchObject({
        code: "P2002",
      });
      expect(await db.user.count({ where: { email: payload.email } })).toBe(0);
      expect(
        await db.employee.count({
          where: { employeeCode: original.employeeCode },
        }),
      ).toBe(1);
      expect(
        await db.auditLog.count({
          where: { resourceId: original.id, action: "EMPLOYEE_CREATED" },
        }),
      ).toBe(1);
    });

    it("keeps ordinary administrator profile editing without changing the password", async () => {
      const created = await createEmployee(superAdmin, input());
      const admin = await actor("ADMIN");
      const previous = await db.user.findUniqueOrThrow({
        where: { id: created.userId },
      });
      await expect(
        updateEmployee(admin, created.id, { name: "Renamed employee" }),
      ).resolves.toMatchObject({ user: { name: "Renamed employee" } });
      const current = await db.user.findUniqueOrThrow({
        where: { id: created.userId },
      });
      expect(current.passwordHash).toBe(previous.passwordHash);
    });
  },
);
