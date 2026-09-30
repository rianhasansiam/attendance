import { randomUUID } from "node:crypto";
import { PrismaClient, type Role } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { expect, test, type BrowserContext } from "@playwright/test";
import { testSessionCookie } from "./session-cookie";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
});
const origin = "http://localhost:3100";

test.beforeEach(async () => db.rateLimit.deleteMany());
// The disposable database owns cleanup because profile creation writes immutable audit history.
test.afterAll(async () => db.$disconnect());

async function identity(role: Role) {
  const id = randomUUID();
  return db.user.create({
    data: {
      name: `Profile ${role}`,
      email: `${id}@example.test`,
      role,
      googleAccountId: id,
      designation: "Existing administrator",
      publicDepartment: "Existing public department",
      accounts: {
        create: { provider: "google", type: "oidc", providerAccountId: id },
      },
    },
  });
}

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

async function office() {
  return db.office.create({
    data: {
      name: `Admin profile ${randomUUID()}`,
      address: "Profile office",
      latitude: 0,
      longitude: 0,
    },
  });
}

for (const role of ["ADMIN", "SUPER_ADMIN"] as const) {
  test(`Super Admin attaches ${role === "SUPER_ADMIN" ? "their own" : "an Admin's"} employee profile without replacing the account`, async ({
    page,
    context,
    browser,
  }) => {
    const actor = await identity("SUPER_ADMIN");
    const target = role === "SUPER_ADMIN" ? actor : await identity(role);
    const assignedOffice = await office();
    const department = await db.department.create({
      data: { name: `Profile department ${randomUUID()}` },
    });
    const employeeCode = randomUUID();
    await signIn(context, actor.id);
    const before = await db.user.findUniqueOrThrow({
      where: { id: target.id },
      include: { accounts: true, sessions: true },
    });
    await page.goto(`/admin/employees?q=${encodeURIComponent(target.email)}`);
    const row = page.getByRole("row").filter({ hasText: target.email });
    await row
      .getByRole("button", { name: "Add employee profile", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Add employee profile",
      exact: true,
    });
    await expect(dialog).toContainText(target.email);
    await expect(dialog.getByLabel("Name *", { exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel("Email *", { exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel("Role", { exact: true })).toHaveCount(0);
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
    await dialog
      .getByLabel("Employee ID *", { exact: true })
      .fill(employeeCode);
    await dialog
      .getByRole("searchbox", { name: "Find office", exact: true })
      .fill(assignedOffice.name);
    await dialog
      .getByLabel("Office *", { exact: true })
      .selectOption(assignedOffice.id);
    await dialog
      .getByRole("searchbox", { name: "Find department", exact: true })
      .fill(department.name);
    await dialog
      .getByLabel("Department", { exact: true })
      .selectOption(department.id);
    const pending = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/admin/users/${target.id}/employee-profile` &&
        response.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    const response = await pending;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON()).toEqual({
      employeeCode,
      officeId: assignedOffice.id,
      departmentId: department.id,
    });
    expect(await response.text()).not.toMatch(
      /passwordHash|googleAccountId|sessionToken|access_token/,
    );
    await expect(dialog).toBeHidden();
    await expect(row).toContainText(employeeCode);
    await expect(
      row.getByRole("button", { name: "Add employee profile", exact: true }),
    ).toHaveCount(0);
    await expect(
      row.getByRole("button", { name: "Edit employee", exact: true }),
    ).toBeVisible();
    expect(
      await db.user.findUniqueOrThrow({
        where: { id: target.id },
        include: { accounts: true, sessions: true },
      }),
    ).toEqual(before);
    expect(await db.user.count({ where: { email: target.email } })).toBe(1);
    const profile = await db.employee.findUniqueOrThrow({
      where: { userId: target.id },
    });
    expect(profile).toMatchObject({
      employeeCode,
      officeId: assignedOffice.id,
      departmentId: department.id,
    });
    await expect(
      row.getByRole("link", { name: "View employee attendance", exact: true }),
    ).toHaveAttribute("href", `/admin/attendance?employeeId=${profile.id}`);

    const targetContext =
      role === "SUPER_ADMIN" ? context : await browser.newContext();
    try {
      if (targetContext !== context) await signIn(targetContext, target.id);
      const targetPage =
        targetContext === context ? page : await targetContext.newPage();
      if (targetPage !== page)
        await targetPage.goto(`${origin}/admin/dashboard`);
      const navigation = targetPage.getByRole("navigation", {
        name: "Main navigation",
      });
      await expect(
        navigation.getByRole("link", { name: "Employee profile", exact: true }),
      ).toHaveAttribute("href", "/employee/profile");
      await expect(
        navigation.getByRole("link", { name: "My workspace", exact: true }),
      ).toHaveAttribute("href", "/employee/dashboard");
      await navigation
        .getByRole("link", { name: "Employee profile", exact: true })
        .click();
      await expect(targetPage).toHaveURL(/\/employee\/profile$/);
      await expect(
        targetPage.getByRole("heading", { name: "My profile", exact: true }),
      ).toBeVisible();
      await expect(targetPage.locator(".detail-list")).toContainText(
        employeeCode,
      );
      await expect(targetPage.locator(".detail-list")).toContainText(
        assignedOffice.name,
      );
      await expect(
        targetPage
          .locator(".detail-item")
          .filter({ hasText: "Account role" })
          .locator("dd"),
      ).toHaveText(role.toLowerCase().replaceAll("_", " "));
      const profileResponse = await targetContext.request.get(
        `${origin}/api/employee/profile`,
      );
      expect(profileResponse.ok()).toBe(true);
      expect((await profileResponse.json()).data).toMatchObject({
        id: profile.id,
        userId: target.id,
        user: { role },
      });
      const dashboardResponse = await targetContext.request.get(
        `${origin}/api/attendance/me`,
      );
      expect(dashboardResponse.ok()).toBe(true);
      expect((await dashboardResponse.json()).data.employee).toMatchObject({
        id: profile.id,
        employeeCode,
      });
      await targetPage.goto(`${origin}/employee/dashboard`);
      await expect(targetPage).toHaveURL(/\/employee\/dashboard$/);
      await expect(
        targetPage
          .getByRole("navigation", { name: "Main navigation" })
          .getByRole("link", { name: "Admin workspace", exact: true }),
      ).toHaveAttribute("href", "/admin/dashboard");
      await targetPage
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("link", { name: "Admin workspace", exact: true })
        .click();
      await expect(targetPage).toHaveURL(/\/admin\/dashboard$/);
      const session = await targetContext.request
        .get(`${origin}/api/auth/session`)
        .then((result) => result.json());
      expect(session.user).toMatchObject({ id: target.id, role });
    } finally {
      if (targetContext !== context) await targetContext.close();
    }
  });

  test(`Super Admin creates a new ${role} with an employee profile`, async ({
    page,
    context,
  }) => {
    await signIn(context, (await identity("SUPER_ADMIN")).id);
    const assignedOffice = await office();
    const employeeCode = randomUUID();
    const email = `${employeeCode}@example.test`;
    await page.goto("/admin/employees");
    await page
      .getByRole("button", { name: "Add employee", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Add employee",
      exact: true,
    });
    await dialog.getByLabel("Name *", { exact: true }).fill(`New ${role}`);
    await dialog.getByLabel("Email *", { exact: true }).fill(email);
    await dialog
      .getByLabel("Employee ID *", { exact: true })
      .fill(employeeCode);
    await dialog.getByLabel("Role", { exact: true }).selectOption(role);
    await dialog
      .getByRole("searchbox", { name: "Find office", exact: true })
      .fill(assignedOffice.name);
    await dialog
      .getByLabel("Office *", { exact: true })
      .selectOption(assignedOffice.id);
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
    const pending = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/admin/employees" &&
        response.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    expect((await pending).ok()).toBe(true);
    await expect(dialog).toBeHidden();
    expect(
      await db.user.findUniqueOrThrow({
        where: { email },
        include: { employee: true },
      }),
    ).toMatchObject({
      role,
      passwordHash: null,
      employee: { employeeCode, officeId: assignedOffice.id },
    });
  });
}

test("ordinary Admin cannot attach profiles through the directory or API", async ({
  page,
  context,
}) => {
  const actor = await identity("ADMIN");
  const assignedOffice = await office();
  await signIn(context, actor.id);
  await page.goto(`/admin/employees?q=${encodeURIComponent(actor.email)}`);
  await expect(
    page.getByRole("button", { name: "Add employee profile", exact: true }),
  ).toHaveCount(0);
  const response = await context.request.post(
    `/api/admin/users/${actor.id}/employee-profile`,
    {
      headers: { origin },
      data: { employeeCode: randomUUID(), officeId: assignedOffice.id },
    },
  );
  expect(response.status()).toBe(403);
  expect((await response.json()).error.code).toBe("FORBIDDEN");
  expect(await db.employee.count({ where: { userId: actor.id } })).toBe(0);
});
