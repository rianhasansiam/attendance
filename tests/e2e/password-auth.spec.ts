import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hash } from "argon2";
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { PrismaClient, type Role } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { testSessionCookie } from "./session-cookie";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
});
const password = "browser application passphrase";
const origin = "http://localhost:3100";
test.beforeEach(async () => {
  await db.rateLimit.deleteMany();
});
test.afterAll(async () => {
  await db.$disconnect();
});

async function user(role: Role = "ADMIN", withPassword = true, google = true) {
  const tag = randomUUID();
  return db.user.create({
    data: {
      email: `password-${tag}@example.test`,
      name: "Password Browser",
      role,
      passwordHash: withPassword ? await hash(password) : null,
      googleAccountId: google ? tag : null,
      ...(google
        ? {
            accounts: {
              create: {
                provider: "google",
                type: "oidc",
                providerAccountId: tag,
              },
            },
          }
        : {}),
      ...(["EMPLOYEE", "MANAGE_DRIVER"].includes(role)
        ? {
            employee: {
              create: {
                employeeCode: tag,
                office: {
                  create: {
                    name: `Password office ${tag}`,
                    address: "Test",
                    latitude: 0,
                    longitude: 0,
                    requireGeofence: false,
                    requireOfficeNetwork: false,
                  },
                },
                shifts: {
                  create: {
                    startDate: new Date("2020-01-01"),
                    shift: {
                      create: {
                        name: `Password shift ${tag}`,
                        startTime: "00:00",
                        endTime: "23:59",
                        graceMinutes: 1440,
                      },
                    },
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
async function login(page: Page, email: string, value = password) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Application password", { exact: true }).fill(value);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
async function fixtureSession(context: BrowserContext, userId: string) {
  const token = randomUUID();
  const row = await db.session.create({
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
  return row;
}

for (const role of [
  "EMPLOYEE",
  "MANAGE_DRIVER",
  "ADMIN",
  "SUPER_ADMIN",
] as const) {
  test(`${role} password login retains identity, RBAC and logout`, async ({
    page,
    context,
  }) => {
    const record = await user(role);
    await login(page, ` ${record.email.toUpperCase()} `);
    await expect(page).toHaveURL(
      new RegExp(
        ["EMPLOYEE", "MANAGE_DRIVER"].includes(role)
          ? "/employee/dashboard$"
          : "/admin/dashboard$",
      ),
    );
    const response = await context.request.get("/api/auth/session");
    const session = await response.json();
    expect(session.user.id).toBe(record.id);
    expect(session.user.role).toBe(role);
    expect(JSON.stringify(session)).not.toMatch(
      /passwordHash|sessionToken|googleAccountId|tokenHash/,
    );
    expect(await db.user.count({ where: { email: record.email } })).toBe(1);
    expect(await db.account.count({ where: { userId: record.id } })).toBe(1);
    expect((await context.request.get("/api/admin/dashboard")).status()).toBe(
      ["ADMIN", "SUPER_ADMIN"].includes(role) ? 200 : 403,
    );
    if (role === "EMPLOYEE") {
      const attendanceAttempt = await context.request.post(
        "/api/attendance/check-in",
        {
          headers: { origin },
          data: {},
        },
      );
      expect(attendanceAttempt.status()).toBe(400);
      expect((await attendanceAttempt.json()).error.code).toBe(
        "WEBAUTHN_REQUIRED",
      );
      expect(
        await db.attendance.count({
          where: { employeeId: record.employee!.id },
        }),
      ).toBe(0);
    }
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(await db.session.count({ where: { userId: record.id } })).toBe(0);
  });
}

test("Google-only user sets a password on the same account, then changes it", async ({
  page,
  context,
}) => {
  const record = await user("ADMIN", false);
  await fixtureSession(context, record.id);
  await page.goto("/account/security");
  await expect(
    page.getByRole("heading", { name: "Set password", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("New application password", { exact: true })
    .fill(password);
  await page.getByLabel("Confirm new password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Set password", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(await db.session.count({ where: { userId: record.id } })).toBe(0);
  await login(page, record.email);
  await expect(page).toHaveURL(/\/admin\/dashboard$/);
  await page.goto("/account/security");
  await page
    .getByLabel("Current application password", { exact: true })
    .fill("wrong application password");
  await page
    .getByLabel("New application password", { exact: true })
    .fill(`${password} changed`);
  await page
    .getByLabel("Confirm new password", { exact: true })
    .fill(`${password} changed`);
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(page.locator("form").getByRole("alert")).toContainText(
    "current application password is incorrect",
  );
  await page
    .getByLabel("Current application password", { exact: true })
    .fill(password);
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(page).toHaveURL(/\/login$/);
  await login(page, record.email, `${password} changed`);
  await expect(page).toHaveURL(/\/admin\/dashboard$/);
  expect(
    (await db.user.findUniqueOrThrow({ where: { id: record.id } }))
      .googleAccountId,
  ).toBe(record.googleAccountId);
  await page.screenshot({
    path: "test-results/password-account.png",
    fullPage: true,
  });
});

test("reset fragment is erased, usable once, revokes sessions, and enables password-only account", async ({
  page,
  context,
}) => {
  const record = await user("ADMIN", false, false);
  const token = randomBytes(32).toString("hex");
  await db.passwordResetToken.create({
    data: {
      userId: record.id,
      email: record.email,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 1800000),
    },
  });
  await page.goto(`/reset-password#token=${token}`);
  await expect(page).toHaveURL(`${origin}/reset-password`);
  await page
    .getByLabel("New application password", { exact: true })
    .fill(password);
  await page.getByLabel("Confirm new password", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "Update password", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "password has been updated",
  );
  const replay = await context.request.post("/api/password/reset", {
    headers: { origin },
    data: { token, newPassword: password, confirmPassword: password },
  });
  expect(replay.status()).toBe(400);
  await login(page, record.email);
  await expect(page).toHaveURL(/\/admin\/dashboard$/);
  expect(
    (await context.request.get("/api/auth/session").then((r) => r.json())).user
      .id,
  ).toBe(record.id);
});

test("unknown credentials fail generically and forgot password uses a generic response", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, `unknown-${randomUUID()}@example.test`);
  await expect(page.locator("form").getByRole("alert")).toHaveText(
    "Invalid email or password.",
  );
  await page.screenshot({
    path: "test-results/password-login-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("link", { name: "Forgot password?", exact: true })
    .click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill(`unknown-${randomUUID()}@example.test`);
  await page.getByRole("button", { name: "Send reset instructions" }).click();
  await expect(page.getByRole("status")).toContainText(
    "If an account exists for this email",
  );
  expect(
    (
      await context.request.post("/api/account/password", {
        headers: { origin },
        data: { newPassword: password, confirmPassword: password },
      })
    ).status(),
  ).toBe(401);
  expect(
    (
      await context.request.post("/api/password/reset", {
        headers: { origin: "https://attacker.test" },
        data: {
          token: "a".repeat(64),
          newPassword: password,
          confirmPassword: password,
        },
      })
    ).status(),
  ).toBe(403);
});
