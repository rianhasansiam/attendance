import { randomUUID } from "node:crypto";
import type { Role, UserStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { listLookupOptions } from "@/modules/management/lookups";
import type { Actor } from "@/modules/management/permissions";
import { listRecords } from "@/modules/management/service";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("employee directory against PostgreSQL", () => {
  const marker = `directory-${randomUUID()}`;
  const fixtures: {
    id: string;
    name: string;
    email: string;
    role: Role;
    status: UserStatus;
    employee: { id: string; employeeCode: string } | null;
  }[] = [];
  let officeId: string;
  let departmentId: string;

  function actor(role: Role): Actor {
    return fixtures.find((user) => user.role === role)!;
  }

  async function directory(role: Role, q = marker, page = 1, pageSize = 100) {
    return listRecords(actor(role), "employees", { q, page, pageSize });
  }

  beforeAll(async () => {
    if (!databaseUrl || !new URL(databaseUrl).pathname.includes("test"))
      throw new Error("Employee directory tests require a test database");
    Object.assign(process.env, { DATABASE_URL: databaseUrl, NODE_ENV: "test" });
    officeId = (
      await db.office.create({
        data: {
          name: marker,
          address: "Directory test office",
          latitude: 0,
          longitude: 0,
        },
      })
    ).id;
    departmentId = (await db.department.create({ data: { name: marker } })).id;

    for (const role of [
      "EMPLOYEE",
      "MANAGE_DRIVER",
      "ADMIN",
      "SUPER_ADMIN",
    ] as const) {
      for (const hasEmployee of [false, true]) {
        const label = `${role}-${hasEmployee ? "profile" : "account"}`;
        fixtures.push(
          await db.user
            .create({
              data: {
                name: `${marker} ${label}`,
                email: `${marker}-${label.toLowerCase()}@example.test`,
                role,
                passwordHash: `private-password-${label}`,
                googleAccountId: `${marker}-private-google-${label}`,
                accounts: {
                  create: {
                    type: "oidc",
                    provider: "google",
                    providerAccountId: `${marker}-${label}`,
                    access_token: "private-directory-access-token",
                    refresh_token: "private-directory-refresh-token",
                  },
                },
                ...(hasEmployee
                  ? {
                      employee: {
                        create: {
                          employeeCode: `${marker}-code-${role}`,
                          officeId,
                          departmentId,
                        },
                      },
                    }
                  : {}),
              },
              select: {
                id: true,
                name: true,
                email: true,
                role: true,
                status: true,
                employee: { select: { id: true, employeeCode: true } },
              },
            })
            .then((user) => ({ ...user, name: user.name! })),
        );
      }
    }

    for (const status of ["INACTIVE", "SUSPENDED"] as const) {
      fixtures.push(
        await db.user
          .create({
            data: {
              name: `${marker} ${status}`,
              email: `${marker}-${status.toLowerCase()}@example.test`,
              role: status === "INACTIVE" ? "ADMIN" : "SUPER_ADMIN",
              status,
            },
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
              status: true,
              employee: { select: { id: true, employeeCode: true } },
            },
          })
          .then((user) => ({ ...user, name: user.name! })),
      );
    }
  });

  afterAll(async () => {
    if (!officeId) return;
    try {
      await db.employee.deleteMany({ where: { officeId } });
      await db.user.deleteMany({
        where: { id: { in: fixtures.map((u) => u.id) } },
      });
      await db.office.delete({ where: { id: officeId } });
      await db.department.delete({ where: { id: departmentId } });
    } finally {
      await db.$disconnect();
    }
  });

  it.each(["ADMIN", "SUPER_ADMIN"] as const)(
    "shows %s every account exactly once, including all roles without employment records",
    async (role) => {
      const result = await directory(role);
      expect(result.total).toBe(10);
      expect(result.items).toHaveLength(10);
      for (const user of fixtures) {
        expect(result.items).toContainEqual(
          expect.objectContaining({
            id: user.employee?.id ?? `user:${user.id}`,
            userId: user.id,
            hasEmployeeProfile: Boolean(user.employee),
            employeeCode: user.employee?.employeeCode ?? null,
            user: expect.objectContaining({
              id: user.id,
              name: user.name,
              email: user.email,
              role: user.role,
              status: user.status,
            }),
            office: user.employee
              ? expect.objectContaining({ id: officeId })
              : null,
            department: user.employee
              ? expect.objectContaining({ id: departmentId })
              : null,
          }),
        );
      }
    },
  );

  it.each(["ADMIN", "SUPER_ADMIN"] as const)(
    "shares one stable pagination window and total for %s",
    async (role) => {
      const full = await directory(role);
      const pages = await Promise.all(
        [1, 2, 3, 4].map((page) => directory(role, marker, page, 3)),
      );
      expect(pages.map((page) => page.total)).toEqual([10, 10, 10, 10]);
      expect(pages.map((page) => page.items.length)).toEqual([3, 3, 3, 1]);
      expect(pages.flatMap((page) => page.items)).toEqual(full.items);
    },
  );

  it("searches account names and emails and linked employee codes", async () => {
    const administrator = actor("SUPER_ADMIN");
    const target = fixtures.find((user) => user.id === administrator.id)!;
    for (const q of [target.name.toUpperCase(), target.email.toUpperCase()]) {
      const result = await directory("ADMIN", q);
      expect(result.total).toBe(1);
      expect(result.items).toEqual([
        expect.objectContaining({ userId: target.id }),
      ]);
    }
    const employee = fixtures.find((user) => user.employee)!;
    const byCode = await directory(
      "SUPER_ADMIN",
      employee.employee!.employeeCode.toUpperCase(),
    );
    expect(byCode.total).toBe(1);
    expect(byCode.items).toEqual([
      expect.objectContaining({ id: employee.employee!.id }),
    ]);
    for (const role of ["EMPLOYEE", "MANAGE_DRIVER"] as const) {
      const accountWithoutProfile = fixtures.find(
        (user) => user.role === role && !user.employee,
      )!;
      expect(
        await directory("ADMIN", accountWithoutProfile.email.toUpperCase()),
      ).toMatchObject({
        total: 1,
        items: [
          {
            userId: accountWithoutProfile.id,
            hasEmployeeProfile: false,
          },
        ],
      });
    }
    expect(await directory("ADMIN", `${marker}-missing`)).toMatchObject({
      total: 0,
      items: [],
    });
  });

  it("does not disclose credentials from either employees or administrator accounts", async () => {
    const result = await directory("SUPER_ADMIN");
    expect(JSON.stringify(result)).not.toMatch(
      /passwordHash|googleAccountId|access_token|refresh_token|private-password|private-google|private-directory/,
    );
  });

  it.each(["ADMIN", "SUPER_ADMIN"] as const)(
    "keeps %s employee selectors limited to actual employment records",
    async (role) => {
      const result = await listLookupOptions(actor(role), "employees", {
        page: 1,
        pageSize: 100,
        q: marker,
      });
      expect(result.total).toBe(4);
      expect(result.items.map((item) => item.id).sort()).toEqual(
        fixtures
          .flatMap((user) => (user.employee ? [user.employee.id] : []))
          .sort(),
      );
    },
  );

  it.each(["EMPLOYEE", "MANAGE_DRIVER"] as const)(
    "continues to deny %s access to the administrator directory",
    async (role) => {
      await expect(directory(role)).rejects.toMatchObject({
        code: "FORBIDDEN",
        status: 403,
      });
    },
  );
});
