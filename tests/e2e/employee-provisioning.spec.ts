import { randomUUID } from "node:crypto";
import { PrismaClient, type Role } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { test, expect, type BrowserContext } from "@playwright/test";
import { testSessionCookie } from "./session-cookie";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
});
const origin = "http://localhost:3100";
const password = "employee initial browser passphrase";

test.beforeEach(async () => {
  await db.rateLimit.deleteMany();
});
test.afterAll(async () => db.$disconnect());

async function signIn(context: BrowserContext, role: Role) {
  const marker = randomUUID();
  const office = await db.office.create({
    data: {
      name: `Provisioning ${marker}`,
      address: "Test office",
      latitude: 0,
      longitude: 0,
    },
  });
  const user = await db.user.create({
    data: {
      name: "Provisioning administrator",
      email: `${marker}@example.test`,
      role,
      googleAccountId: marker,
      accounts: {
        create: {
          provider: "google",
          type: "oidc",
          providerAccountId: marker,
        },
      },
    },
  });
  const token = randomUUID();
  await db.session.create({
    data: {
      userId: user.id,
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
  return { user, office };
}

test("Super Admin creates an employee with a matching password that signs in to the same identity", async ({
  page,
  context,
  browser,
}) => {
  const { user, office } = await signIn(context, "SUPER_ADMIN");
  const id = randomUUID();
  const email = `employee-${id}@example.test`;
  const name = `New employee ${id}`;
  await page.goto("/admin/employees");
  await expect(page).toHaveURL(/\/admin\/employees$/);
  await page.getByRole("button", { name: "Add employee", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Add employee",
    exact: true,
  });
  await dialog.getByLabel("Name *", { exact: true }).fill(name);
  await dialog.getByLabel("Email *", { exact: true }).fill(email);
  await dialog.getByLabel("Employee ID *", { exact: true }).fill(id);
  await dialog
    .getByRole("searchbox", { name: "Find office", exact: true })
    .fill(office.name);
  await dialog.getByLabel("Office *", { exact: true }).selectOption(office.id);
  const passwordField = dialog.getByLabel("Application password *", {
    exact: true,
  });
  const confirmationField = dialog.getByLabel("Confirm password *", {
    exact: true,
  });
  await expect(passwordField).toHaveAttribute("type", "password");
  await expect(passwordField).toHaveAttribute("autocomplete", "new-password");
  await passwordField.fill(password);
  await confirmationField.fill("this password does not match");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toContainText(/passwords do not match/i);
  expect(await db.user.count({ where: { email } })).toBe(0);

  await confirmationField.fill(password);
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/admin/employees" &&
      response.request().method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const body = await response.text();
  expect(body).not.toContain(password);
  expect(body).not.toMatch(/passwordHash|confirmPassword|argon2id/);
  await expect(dialog).toBeHidden();
  const created = await db.user.findUniqueOrThrow({
    where: { email },
    include: { employee: true },
  });
  expect(created.role).toBe("EMPLOYEE");
  expect(created.passwordHash).toMatch(/^\$argon2id\$/);
  expect(created.employee?.employeeCode).toBe(id);
  const audit = await db.auditLog.findFirstOrThrow({
    where: {
      resourceId: created.employee!.id,
      action: "EMPLOYEE_CREATED",
      actorId: user.id,
    },
  });
  expect(JSON.stringify(audit)).not.toContain(password);
  expect(JSON.stringify(audit)).not.toMatch(
    /passwordHash|confirmPassword|argon2id/,
  );

  const employeeContext = await browser.newContext();
  try {
    const employeePage = await employeeContext.newPage();
    await employeePage.goto(`${origin}/login`);
    await employeePage.getByLabel("Email", { exact: true }).fill(email);
    await employeePage
      .getByLabel("Application password", { exact: true })
      .fill(password);
    await employeePage
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await expect(employeePage).toHaveURL(/\/employee\/dashboard$/);
    const session = await employeeContext.request
      .get(`${origin}/api/auth/session`)
      .then((result) => result.json());
    expect(session.user.id).toBe(created.id);
    expect(session.user.role).toBe("EMPLOYEE");
    expect(await db.user.count({ where: { email } })).toBe(1);
  } finally {
    await employeeContext.close();
  }
});

test("Admin can edit employment records but cannot edit public names or create employee accounts", async ({
  page,
  context,
}) => {
  const { office } = await signIn(context, "ADMIN");
  const id = randomUUID();
  const target = await db.user.create({
    data: {
      name: "Existing employee",
      email: `${id}@example.test`,
      employee: { create: { employeeCode: id, officeId: office.id } },
    },
    include: { employee: true },
  });
  await page.goto(`/admin/employees?q=${encodeURIComponent(target.email)}`);
  await expect(page).toHaveURL(/\/admin\/employees\?/);
  await expect(
    page.getByRole("button", { name: "Add employee", exact: true }),
  ).toHaveCount(0);
  const row = page.getByRole("row").filter({ hasText: target.email });
  await row.getByRole("button", { name: "Edit employee", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Edit employee",
    exact: true,
  });
  await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
  await expect(dialog.getByLabel("Name *", { exact: true })).toHaveCount(0);
  await expect(dialog).toContainText(
    "Only Super Admin can change the name and public profile details.",
  );
  const updatedEmployeeCode = `updated-${id.slice(0, 20)}`;
  await dialog
    .getByLabel("Employee ID *", { exact: true })
    .fill(updatedEmployeeCode);
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(
    (
      await db.employee.findUniqueOrThrow({
        where: { id: target.employee!.id },
      })
    ).employeeCode,
  ).toBe(updatedEmployeeCode);
  expect(
    (await db.user.findUniqueOrThrow({ where: { id: target.id } })).name,
  ).toBe(target.name);

  const blockedEmail = `blocked-${id}@example.test`;
  const response = await context.request.post("/api/admin/employees", {
    headers: { origin },
    data: {
      name: "Unauthorized employee",
      email: blockedEmail,
      employeeCode: `blocked-${id.slice(0, 20)}`,
      officeId: office.id,
      password,
      confirmPassword: password,
    },
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).error.code).toBe("FORBIDDEN");
  expect(await db.user.count({ where: { email: blockedEmail } })).toBe(0);
});
