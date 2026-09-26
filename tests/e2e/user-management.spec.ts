import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext } from "@playwright/test";
import { PrismaClient, type Role } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { testSessionCookie } from "./session-cookie";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
});
const origin = "http://localhost:3100";

test.afterAll(async () => {
  await db.$disconnect();
});

async function fixture(role: Role, group = randomUUID()) {
  const key = randomUUID();
  return db.user.create({
    data: {
      name: `${group} ${role}`,
      email: `users-${key}@example.test`,
      role,
      googleAccountId: key,
      accounts: {
        create: { provider: "google", type: "oidc", providerAccountId: key },
      },
      ...(["EMPLOYEE", "MANAGE_DRIVER"].includes(role)
        ? {
            employee: {
              create: {
                employeeCode: key,
                office: {
                  create: {
                    name: `Users office ${key}`,
                    address: "Test",
                    latitude: 0,
                    longitude: 0,
                  },
                },
              },
            },
          }
        : {}),
    },
    include: { employee: true },
  });
}

async function signIn(context: BrowserContext, userId: string) {
  for (const page of context.pages()) await page.goto("about:blank");
  const token = randomUUID();
  await db.session.create({
    data: {
      userId,
      sessionToken: token,
      expires: new Date(Date.now() + 3600000),
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

test("only Super Admin can open All Users or call its read and write endpoints", async ({
  page,
  context,
}) => {
  const target = await fixture("ADMIN");
  for (const role of ["ADMIN", "EMPLOYEE", "MANAGE_DRIVER"] as const) {
    const actor = await fixture(role);
    await signIn(context, actor.id);
    await page.goto(
      role === "ADMIN" ? "/admin/employees" : "/employee/profile",
    );
    await expect(
      page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("link", { name: "All Users", exact: true }),
    ).toHaveCount(0);
    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/forbidden$/);
    expect((await context.request.get("/api/admin/users")).status(), role).toBe(
      403,
    );
    expect(
      (await context.request.get(`/api/admin/users/${target.id}`)).status(),
      role,
    ).toBe(403);
    expect(
      (
        await context.request.patch(`/api/admin/users/${target.id}`, {
          headers: { origin },
          data: { role: "SUPER_ADMIN" },
        })
      ).status(),
      role,
    ).toBe(403);
    expect(
      (
        await context.request.delete(`/api/admin/users/${target.id}`, {
          headers: { origin },
        })
      ).status(),
      role,
    ).toBe(403);
  }
  expect(
    (await db.user.findUniqueOrThrow({ where: { id: target.id } })).role,
  ).toBe("ADMIN");
});

test("Super Admin sees every role, changes roles and permanently deletes an unused administrator", async ({
  page,
  context,
  browser,
}) => {
  const group = randomUUID();
  const actor = await fixture("SUPER_ADMIN", group);
  const employee = await fixture("EMPLOYEE", group);
  const manager = await fixture("MANAGE_DRIVER", group);
  const admin = await fixture("ADMIN", group);
  const otherSuperAdmin = await fixture("SUPER_ADMIN", group);
  const deletedContext = await browser.newContext();
  try {
    await signIn(deletedContext, admin.id);
    await signIn(context, actor.id);
    await page.goto("/admin/users");
    await expect(
      page.getByRole("heading", { name: "All Users", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("link", { name: "All Users", exact: true }),
    ).toHaveAttribute("href", "/admin/users");
    await page.getByRole("textbox", { name: "Search all users" }).fill(group);
    for (const user of [actor, employee, manager, admin, otherSuperAdmin]) {
      await expect(
        page.getByRole("row").filter({ hasText: user.email }),
      ).toBeVisible();
    }
    await expect(
      page.getByRole("button", { name: "Add user", exact: true }),
    ).toHaveCount(0);
    const ownRow = page.getByRole("row").filter({ hasText: actor.email });
    await expect(
      ownRow.getByRole("button", { name: "Delete user", exact: true }),
    ).toHaveCount(0);
    await ownRow
      .getByRole("button", { name: "Edit user", exact: true })
      .click();
    const edit = page.getByRole("dialog", { name: "Edit user" });
    await expect(edit.getByLabel(/^Role/)).toHaveCount(0);
    await expect(
      edit.getByLabel("Account status", { exact: true }),
    ).toHaveCount(0);
    await edit.getByRole("button", { name: "Cancel", exact: true }).click();

    const adminRow = page.getByRole("row").filter({ hasText: admin.email });
    await adminRow
      .getByRole("button", { name: "Edit user", exact: true })
      .click();
    await expect(
      edit.getByText(
        "Employee and Manage Driver roles require an employee profile. This account does not have one.",
      ),
    ).toBeVisible();
    await expect(
      edit.getByLabel(/^Role/).locator('option[value="EMPLOYEE"]'),
    ).toBeDisabled();
    await expect(
      edit.getByLabel(/^Role/).locator('option[value="MANAGE_DRIVER"]'),
    ).toBeDisabled();
    await edit.getByRole("button", { name: "Cancel", exact: true }).click();

    const employeeRow = page
      .getByRole("row")
      .filter({ hasText: employee.email });
    for (const role of [
      "MANAGE_DRIVER",
      "ADMIN",
      "SUPER_ADMIN",
      "EMPLOYEE",
    ] as const) {
      await employeeRow
        .getByRole("button", { name: "Edit user", exact: true })
        .click();
      await edit.getByLabel(/^Role/).selectOption(role);
      await edit
        .getByRole("button", { name: "Save changes", exact: true })
        .click();
      await expect(edit).toBeHidden();
      await expect(employeeRow).toContainText(
        role.toLowerCase().replaceAll("_", " "),
      );
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: employee.id } })).role,
      ).toBe(role);
    }

    await adminRow
      .getByRole("button", { name: "Delete user", exact: true })
      .click();
    const confirmation = page.getByRole("dialog", { name: "Delete user?" });
    await expect(confirmation).toContainText(
      "Permanently delete this user account?",
    );
    await expect(confirmation).toContainText("deleted info");
    await confirmation
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(adminRow).toBeVisible();
    expect(await db.user.count({ where: { id: admin.id } })).toBe(1);
    await adminRow
      .getByRole("button", { name: "Delete user", exact: true })
      .click();
    await confirmation
      .getByRole("button", { name: "Delete user", exact: true })
      .click();
    await expect(page.locator('.notice[role="status"]')).toContainText(
      "User account permanently deleted.",
    );
    await expect(adminRow).toHaveCount(0);
    expect(await db.user.count({ where: { id: admin.id } })).toBe(0);
    expect(await db.account.count({ where: { userId: admin.id } })).toBe(0);
    expect(await db.session.count({ where: { userId: admin.id } })).toBe(0);
    expect(
      await db.auditLog.count({
        where: {
          actorId: actor.id,
          action: "USER_DELETED",
          resourceId: admin.id,
        },
      }),
    ).toBe(1);
    expect(
      (await deletedContext.request.get("/api/admin/employees")).status(),
    ).toBe(401);
  } finally {
    await deletedContext.close();
  }
});

test("All Users deletion keeps linked leave history with deleted info", async ({
  page,
  context,
}) => {
  const actor = await fixture("SUPER_ADMIN");
  const target = await fixture("EMPLOYEE");
  const leave = await db.leave.create({
    data: {
      employeeId: target.employee!.id,
      startDate: new Date("2026-10-01"),
      endDate: new Date("2026-10-01"),
      reason: "User deletion must preserve history",
    },
  });
  await signIn(context, actor.id);
  await page.goto("/admin/users");
  await page
    .getByRole("textbox", { name: "Search all users" })
    .fill(target.email);
  const row = page.getByRole("row").filter({ hasText: target.email });
  await expect(row).toBeVisible();
  const response = page.waitForResponse(
    (result) =>
      result.request().method() === "DELETE" &&
      result.url().endsWith(`/api/admin/users/${target.id}`),
  );
  await row.getByRole("button", { name: "Delete user", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Delete user?" })
    .getByRole("button", { name: "Delete user", exact: true })
    .click();
  expect((await response).status()).toBe(200);
  await expect(row).toHaveCount(0);
  expect(await db.user.count({ where: { id: target.id } })).toBe(0);
  expect(await db.employee.count({ where: { id: target.employee!.id } })).toBe(
    0,
  );
  expect(await db.leave.findUnique({ where: { id: leave.id } })).toMatchObject({
    employeeId: null,
    reason: leave.reason,
    status: leave.status,
  });
  expect(
    await db.auditLog.count({
      where: { resourceId: target.id, action: "USER_DELETED" },
    }),
  ).toBe(1);
  await page.goto("/admin/leaves");
  const history = page.getByRole("row").filter({ hasText: leave.reason });
  await expect(history).toContainText("deleted info");
  await expect(
    history.getByRole("button", { name: "Approve", exact: true }),
  ).toHaveCount(0);
  expect(
    (
      await context.request.patch(`/api/admin/leaves/${leave.id}`, {
        headers: { origin },
        data: { status: "APPROVED" },
      })
    ).status(),
  ).toBe(409);
});
