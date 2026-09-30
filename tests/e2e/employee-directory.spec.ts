import { randomUUID } from "node:crypto";
import { PrismaClient, type Role } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type BrowserContext } from "@playwright/test";
import { testSessionCookie } from "./session-cookie";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
});
const marker = `directory-browser-${randomUUID()}`;
const origin = "http://localhost:3100";
const fixtures: {
  id: string;
  email: string;
  role: Role;
  employee: { id: string; employeeCode: string } | null;
}[] = [];
let officeId: string;

test.beforeAll(async () => {
  officeId = (
    await db.office.create({
      data: {
        name: marker,
        address: "Directory browser office",
        latitude: 0,
        longitude: 0,
      },
    })
  ).id;
  for (const role of [
    "EMPLOYEE",
    "MANAGE_DRIVER",
    "ADMIN",
    "SUPER_ADMIN",
  ] as const) {
    for (const hasEmployee of [false, true]) {
      const label = `${role.toLowerCase()}-${hasEmployee ? "profile" : "account"}`;
      const providerId = `${marker}-${label}`;
      fixtures.push(
        await db.user.create({
          data: {
            name: `Directory ${label}`,
            email: `${marker}-${label}@example.test`,
            role,
            googleAccountId: providerId,
            accounts: {
              create: {
                provider: "google",
                type: "oidc",
                providerAccountId: providerId,
              },
            },
            ...(hasEmployee
              ? {
                  employee: {
                    create: {
                      employeeCode: `${marker}-${label}`,
                      officeId,
                    },
                  },
                }
              : {}),
          },
          select: {
            id: true,
            email: true,
            role: true,
            employee: { select: { id: true, employeeCode: true } },
          },
        }),
      );
    }
  }
});

test.afterAll(async () => {
  try {
    if (officeId) {
      await db.employee.deleteMany({ where: { officeId } });
      await db.user.deleteMany({
        where: { id: { in: fixtures.map((user) => user.id) } },
      });
      await db.office.delete({ where: { id: officeId } });
    }
  } finally {
    await db.$disconnect();
  }
});

async function signIn(context: BrowserContext, userId: string) {
  const token = randomUUID();
  await db.session.create({
    data: {
      userId,
      sessionToken: token,
      expires: new Date(Date.now() + 3_600_000),
    },
  });
  await context.addCookies([
    {
      name: "authjs.session-token",
      value: await testSessionCookie(db, token),
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

for (const role of ["ADMIN", "SUPER_ADMIN"] as const) {
  test(`${role} sees every role in one directory with role-appropriate actions`, async ({
    page,
    context,
  }) => {
    const actor = fixtures.find(
      (user) => user.role === role && !user.employee,
    )!;
    await signIn(context, actor.id);
    await page.goto(`/admin/employees?q=${encodeURIComponent(marker)}`);
    await expect(
      page.getByRole("heading", { name: "Users & employees", exact: true }),
    ).toBeVisible();
    const navigation = page.getByRole("navigation", {
      name: "Main navigation",
    });
    await expect(
      navigation.getByRole("link", { name: "Users & employees", exact: true }),
    ).toHaveAttribute("href", "/admin/employees");
    await expect(
      navigation.getByRole("link", { name: "All Users", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("columnheader", { name: "Role", exact: true }),
    ).toBeVisible();
    for (const target of fixtures) {
      const row = page.getByRole("row").filter({ hasText: target.email });
      await expect(row).toHaveCount(1);
      await expect(
        row.getByRole("cell", {
          name: target.role.toLowerCase().replaceAll("_", " "),
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        row.getByRole("link", {
          name: "View public profile (opens in new tab)",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        row.getByRole("link", { name: "Edit public profile", exact: true }),
      ).toHaveCount(role === "SUPER_ADMIN" ? 1 : 0);
      await expect(
        row.getByRole("button", { name: "Manage account", exact: true }),
      ).toHaveCount(role === "SUPER_ADMIN" ? 1 : 0);
      await expect(
        row.getByRole("button", { name: "Delete user", exact: true }),
      ).toHaveCount(role === "SUPER_ADMIN" && target.id !== actor.id ? 1 : 0);
      await expect(
        row.getByRole("button", { name: "Delete employee", exact: true }),
      ).toHaveCount(0);
      const attendance = row.getByRole("link", {
        name: "View employee attendance",
        exact: true,
      });
      const edit = row.getByRole("button", {
        name: "Edit employee",
        exact: true,
      });
      if (target.employee) {
        await expect(row).toContainText(target.employee.employeeCode);
        await expect(attendance).toHaveAttribute(
          "href",
          `/admin/attendance?employeeId=${encodeURIComponent(target.employee.id)}`,
        );
        await expect(edit).toHaveCount(
          role === "SUPER_ADMIN" ||
            ["EMPLOYEE", "MANAGE_DRIVER"].includes(target.role)
            ? 1
            : 0,
        );
      } else {
        await expect(
          row.getByRole("cell", { name: "—", exact: true }),
        ).toHaveCount(3);
        await expect(attendance).toHaveCount(0);
        await expect(edit).toHaveCount(0);
      }
    }

    if (role === "SUPER_ADMIN") {
      const target = fixtures.find(
        (user) => user.role === "ADMIN" && !user.employee,
      )!;
      await page
        .getByRole("row")
        .filter({ hasText: target.email })
        .getByRole("button", { name: "Manage account", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "Manage account" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(target.email);
      await expect(page).toHaveURL(
        new RegExp(`/admin/employees\\?q=${marker}`),
      );
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    }
  });

  test(`${role} legacy All Users link redirects and preserves search and page`, async ({
    page,
    context,
  }) => {
    const actor = fixtures.find((user) => user.role === role)!;
    await signIn(context, actor.id);
    await page.goto(`/admin/users?q=${encodeURIComponent(marker)}&page=2`);
    await expect(page).toHaveURL(
      `${origin}/admin/employees?q=${encodeURIComponent(marker)}&page=2`,
    );
    await expect(
      page.getByRole("textbox", { name: "Search users & employees" }),
    ).toHaveValue(marker);
    await expect(page.locator(".pagination")).toContainText("Page 2");
    await page.getByRole("button", { name: "Previous", exact: true }).click();
    for (const target of fixtures) {
      await expect(
        page.getByRole("row").filter({ hasText: target.email }),
      ).toBeVisible();
    }
  });
}
