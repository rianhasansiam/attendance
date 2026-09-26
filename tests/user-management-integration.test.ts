import { randomUUID } from "node:crypto";
import type { Role } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { listRecords, removeRecord } from "@/modules/management/service";
import { deleteUser, updateUser } from "@/modules/management/workflows";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("All Users PostgreSQL workflows", () => {
  let actor: { id: string; role: Role };
  let officeId: string;
  const tag = randomUUID();

  async function user(role: Role, withProfile = false) {
    const key = randomUUID();
    return db.user.create({
      data: {
        name: `All Users ${tag} ${role}`,
        email: `${key}@example.test`,
        role,
        ...(withProfile
          ? { employee: { create: { employeeCode: key, officeId } } }
          : {}),
      },
      include: { employee: true },
    });
  }

  async function session(userId: string) {
    return db.session.create({
      data: {
        userId,
        sessionToken: randomUUID(),
        expires: new Date(Date.now() + 3600000),
      },
    });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    officeId = (
      await db.office.create({
        data: {
          name: `All Users ${tag}`,
          address: "Test office",
          latitude: 0,
          longitude: 0,
        },
      })
    ).id;
    actor = await user("SUPER_ADMIN");
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("lists every role, including inactive users, with profile availability and no credentials", async () => {
    const targets = await Promise.all(
      (["EMPLOYEE", "MANAGE_DRIVER", "ADMIN", "SUPER_ADMIN"] as const).map(
        (role) => user(role, role === "EMPLOYEE" || role === "MANAGE_DRIVER"),
      ),
    );
    await db.user.update({
      where: { id: targets[0].id },
      data: { status: "INACTIVE", passwordHash: "must-not-leak" },
    });
    const result = await listRecords(actor, "users", {
      page: 1,
      pageSize: 100,
      q: tag,
    });
    expect(result.items).toEqual(
      expect.arrayContaining(
        targets.map((target) =>
          expect.objectContaining({ id: target.id, role: target.role }),
        ),
      ),
    );
    expect(result.items).toContainEqual(
      expect.objectContaining({
        id: targets[0].id,
        status: "INACTIVE",
        employee: expect.objectContaining({ id: targets[0].employee!.id }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain("passwordHash");
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it.each(["EMPLOYEE", "MANAGE_DRIVER", "ADMIN"] as const)(
    "denies %s listing, role changes and deletion",
    async (role) => {
      const unauthorized = await user(role, role !== "ADMIN");
      const target = await user("EMPLOYEE", true);
      await expect(
        listRecords(unauthorized, "users", { page: 1, pageSize: 25 }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        updateUser(unauthorized, target.id, { role: "ADMIN" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        removeRecord(unauthorized, "users", target.id),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(
        await db.user.findUnique({ where: { id: target.id } }),
      ).toMatchObject({
        role: "EMPLOYEE",
      });
    },
  );

  it("changes an employee through every role, revoking sessions and retaining the profile", async () => {
    const target = await user("EMPLOYEE", true);
    for (const role of [
      "MANAGE_DRIVER",
      "ADMIN",
      "SUPER_ADMIN",
      "EMPLOYEE",
    ] as const) {
      await session(target.id);
      expect(await updateUser(actor, target.id, { role })).toMatchObject({
        role,
      });
      expect(await db.session.count({ where: { userId: target.id } })).toBe(0);
      expect(
        await db.employee.findUnique({ where: { userId: target.id } }),
      ).toMatchObject({
        id: target.employee!.id,
      });
    }
    expect(
      await db.auditLog.count({
        where: {
          resource: "User",
          resourceId: target.id,
          action: "ROLE_CHANGED",
          actorId: actor.id,
        },
      }),
    ).toBe(4);
  });

  it.each(["EMPLOYEE", "MANAGE_DRIVER"] as const)(
    "rejects %s for accounts without an employee profile",
    async (role) => {
      const target = await user("ADMIN");
      await session(target.id);
      await expect(
        updateUser(actor, target.id, { role }),
      ).rejects.toMatchObject({
        code: "EMPLOYEE_REQUIRED",
      });
      expect(await db.session.count({ where: { userId: target.id } })).toBe(1);
      expect(
        await db.user.findUnique({ where: { id: target.id } }),
      ).toMatchObject({ role: "ADMIN" });
    },
  );

  it("protects the current super admin from deletion, demotion and deactivation", async () => {
    await expect(deleteUser(actor, actor.id)).rejects.toMatchObject({
      code: "SELF_DELETE",
    });
    await expect(
      updateUser(actor, actor.id, { role: "ADMIN" }),
    ).rejects.toMatchObject({ code: "SELF_ACCESS_CHANGE" });
    await expect(
      updateUser(actor, actor.id, { status: "INACTIVE" }),
    ).rejects.toMatchObject({ code: "SELF_ACCESS_CHANGE" });
    expect(await db.user.findUnique({ where: { id: actor.id } })).toMatchObject(
      { role: "SUPER_ADMIN", status: "ACTIVE" },
    );
  });

  it.each(["ADMIN", "INACTIVE", "SUSPENDED", "MISSING"] as const)(
    "rechecks persisted authority when a super admin becomes %s",
    async (change) => {
      const stale = await user("SUPER_ADMIN");
      const target = await user("ADMIN");
      if (change === "MISSING")
        await db.user.delete({ where: { id: stale.id } });
      else
        await db.user.update({
          where: { id: stale.id },
          data: change === "ADMIN" ? { role: change } : { status: change },
        });
      await expect(
        updateUser(stale, target.id, { role: "SUPER_ADMIN" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(deleteUser(stale, target.id)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(
        await db.user.findUnique({ where: { id: target.id } }),
      ).toMatchObject({ role: "ADMIN" });
    },
  );

  it.each(["EMPLOYEE", "MANAGE_DRIVER", "ADMIN", "SUPER_ADMIN"] as const)(
    "permanently deletes a %s account and its sign-in data with an audit snapshot",
    async (role) => {
      const target = await user(
        role,
        role === "EMPLOYEE" || role === "MANAGE_DRIVER",
      );
      await session(target.id);
      await db.account.create({
        data: {
          userId: target.id,
          type: "oidc",
          provider: "google",
          providerAccountId: randomUUID(),
        },
      });
      await db.passwordResetToken.create({
        data: {
          userId: target.id,
          email: target.email,
          tokenHash: randomUUID(),
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      if (target.employee) {
        await db.webAuthnCredential.create({
          data: {
            employeeId: target.employee.id,
            name: "Test passkey",
            credentialId: randomUUID(),
            publicKey: new Uint8Array([1]),
            transports: [],
            deviceType: "singleDevice",
          },
        });
        await db.webAuthnChallenge.create({
          data: {
            employeeId: target.employee.id,
            sessionId: randomUUID(),
            challenge: randomUUID(),
            purpose: "REGISTRATION",
            expiresAt: new Date(Date.now() + 3600000),
          },
        });
      }
      expect(await removeRecord(actor, "users", target.id)).toEqual({
        id: target.id,
      });
      expect(await db.user.findUnique({ where: { id: target.id } })).toBeNull();
      expect(await db.employee.count({ where: { userId: target.id } })).toBe(0);
      expect(await db.session.count({ where: { userId: target.id } })).toBe(0);
      expect(await db.account.count({ where: { userId: target.id } })).toBe(0);
      expect(
        await db.passwordResetToken.count({ where: { userId: target.id } }),
      ).toBe(0);
      if (target.employee) {
        expect(
          await db.webAuthnCredential.count({
            where: { employeeId: target.employee.id },
          }),
        ).toBe(0);
        expect(
          await db.webAuthnChallenge.count({
            where: { employeeId: target.employee.id },
          }),
        ).toBe(0);
      }
      expect(
        await db.auditLog.findFirst({
          where: {
            resource: "User",
            resourceId: target.id,
            action: "USER_DELETED",
          },
        }),
      ).toMatchObject({
        actorId: actor.id,
        previousState: expect.objectContaining({ id: "deleted info", role }),
      });
    },
  );

  it("deletes an employee with linked leave history and removes their sign-in data", async () => {
    const target = await user("EMPLOYEE", true);
    await session(target.id);
    await db.webAuthnCredential.create({
      data: {
        employeeId: target.employee!.id,
        name: "Removed passkey",
        credentialId: randomUUID(),
        publicKey: new Uint8Array([1]),
        transports: [],
        deviceType: "singleDevice",
      },
    });
    const leave = await db.leave.create({
      data: {
        employeeId: target.employee!.id,
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-01-02"),
        reason: "Test history",
      },
    });
    await expect(deleteUser(actor, target.id)).resolves.toEqual({
      id: target.id,
    });
    expect(await db.user.findUnique({ where: { id: target.id } })).toBeNull();
    expect(
      await db.employee.findUnique({ where: { id: target.employee!.id } }),
    ).toBeNull();
    expect(
      await db.webAuthnCredential.count({
        where: { employeeId: target.employee!.id },
      }),
    ).toBe(0);
    expect(await db.session.count({ where: { userId: target.id } })).toBe(0);
    expect(
      await db.leave.findUnique({ where: { id: leave.id } }),
    ).toMatchObject({
      id: leave.id,
      employeeId: null,
      status: leave.status,
      startDate: leave.startDate,
      endDate: leave.endDate,
    });
    expect(
      await db.auditLog.count({
        where: { resourceId: target.id, action: "USER_DELETED" },
      }),
    ).toBe(1);
  });

  it("deletes an administrator while retaining reviewed leave and anonymizing historical snapshots", async () => {
    const target = await user("ADMIN");
    const employee = await user("EMPLOYEE", true);
    const audit = await db.auditLog.create({
      data: {
        actorId: target.id,
        action: "TEST_HISTORY",
        resource: "User",
        resourceId: target.id,
        previousState: {
          id: target.id,
          name: target.name,
          email: target.email,
          role: target.role,
        },
        newState: {
          reviewedBy: { id: target.id, name: target.name, email: target.email },
          employee: {
            id: employee.employee!.id,
            user: {
              id: employee.id,
              name: employee.name,
              email: employee.email,
            },
          },
          amount: "125.50",
        },
      },
    });
    const leave = await db.leave.create({
      data: {
        employeeId: employee.employee!.id,
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-01-02"),
        reason: "Review history",
        status: "APPROVED",
        reviewedById: target.id,
        reviewedAt: new Date("2026-01-03"),
      },
    });
    await expect(deleteUser(actor, target.id)).resolves.toEqual({
      id: target.id,
    });
    expect(await db.user.findUnique({ where: { id: target.id } })).toBeNull();
    expect(
      await db.leave.findUnique({ where: { id: leave.id } }),
    ).toMatchObject({
      employeeId: employee.employee!.id,
      reviewedById: null,
      reviewedAt: leave.reviewedAt,
      status: "APPROVED",
    });
    const retained = await db.auditLog.findUniqueOrThrow({
      where: { id: audit.id },
    });
    expect(retained).toMatchObject({
      actorId: null,
      action: audit.action,
      resourceId: target.id,
      previousState: {
        id: "deleted info",
        name: "deleted info",
        email: "deleted info",
        role: "ADMIN",
      },
      newState: {
        reviewedBy: {
          id: "deleted info",
          name: "deleted info",
          email: "deleted info",
        },
        employee: {
          id: employee.employee!.id,
          user: { id: employee.id, name: employee.name, email: employee.email },
        },
        amount: "125.50",
      },
    });
    const deletion = await db.auditLog.findFirstOrThrow({
      where: { resourceId: target.id, action: "USER_DELETED" },
    });
    expect(JSON.stringify(deletion.previousState)).not.toContain(target.email);
    expect(JSON.stringify(deletion.previousState)).not.toContain(target.name!);
    expect(
      await db.user.findUnique({ where: { id: employee.id } }),
    ).toMatchObject({ email: employee.email });
    await expect(
      db.auditLog.update({
        where: { id: audit.id },
        data: { action: "FORGED" },
      }),
    ).rejects.toThrow();
    await expect(
      db.auditLog.delete({ where: { id: audit.id } }),
    ).rejects.toThrow();
  });

  it("serializes concurrent attempts by super admins to demote each other", async () => {
    const first = await user("SUPER_ADMIN");
    const second = await user("SUPER_ADMIN");
    const results = await Promise.allSettled([
      updateUser(first, second.id, { role: "ADMIN" }),
      updateUser(second, first.id, { role: "ADMIN" }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected")
        expect(["FORBIDDEN", "CONFLICT", "P2034"]).toContain(
          result.reason.code,
        );
    }
    expect(
      await db.user.count({
        where: {
          id: { in: [first.id, second.id] },
          role: "SUPER_ADMIN",
          status: "ACTIVE",
        },
      }),
    ).toBe(1);
  });
});
