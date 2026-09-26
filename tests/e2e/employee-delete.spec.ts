import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext } from "@playwright/test";
import { PrismaClient, type Role, type UserStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { testSessionCookie } from "./session-cookie";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
});
const origin = "http://localhost:3100";
test.afterAll(async () => {
  await db.$disconnect();
});

async function fixture(role: Role, status: UserStatus = "ACTIVE") {
  const key = randomUUID();
  return db.user.create({
    data: {
      name: `Delete employee ${key}`,
      email: `delete-${key}@example.test`,
      role,
      status,
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
                    name: `Delete office ${key}`,
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

test("Admin cannot see or call employee deletion; other non-super roles are also denied", async ({
  page,
  context,
  browser,
}) => {
  const target = await fixture("EMPLOYEE");
  const admin = await fixture("ADMIN");
  await signIn(context, admin.id);
  await page.goto("/admin/employees");
  await page
    .getByRole("textbox", { name: "Search employees" })
    .fill(target.email);
  const row = page.getByRole("row").filter({ hasText: target.email });
  await expect(row).toBeVisible();
  await expect(
    row.getByRole("button", { name: "Edit employee", exact: true }),
  ).toBeVisible();
  await expect(
    row.getByRole("button", { name: "Delete employee", exact: true }),
  ).toHaveCount(0);
  expect(
    (
      await context.request.delete(
        `/api/admin/employees/${target.employee!.id}`,
        { headers: { origin } },
      )
    ).status(),
  ).toBe(403);
  for (const role of ["EMPLOYEE", "MANAGE_DRIVER"] as const) {
    const actor = await fixture(role);
    const actorContext = await browser.newContext();
    try {
      await signIn(actorContext, actor.id);
      expect(
        (
          await actorContext.request.delete(
            `/api/admin/employees/${target.employee!.id}`,
            { headers: { origin } },
          )
        ).status(),
      ).toBe(403);
    } finally {
      await actorContext.close();
    }
  }
  expect(
    (await db.user.findUniqueOrThrow({ where: { id: target.id } })).status,
  ).toBe("ACTIVE");
  expect(
    await db.auditLog.count({
      where: { resourceId: target.employee!.id, action: "EMPLOYEE_DELETED" },
    }),
  ).toBe(0);
});

async function authenticationRecords(
  user: Awaited<ReturnType<typeof fixture>>,
) {
  const employeeId = user.employee!.id;
  await db.webAuthnCredential.create({
    data: {
      employeeId,
      name: "Deletion test device",
      credentialId: randomUUID(),
      publicKey: new Uint8Array([1, 2, 3]),
      transports: ["internal"],
      deviceType: "singleDevice",
    },
  });
  await db.webAuthnChallenge.create({
    data: {
      employeeId,
      sessionId: randomUUID(),
      challenge: randomUUID(),
      purpose: "REGISTRATION",
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  await db.passwordResetToken.create({
    data: {
      userId: user.id,
      email: user.email,
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
}

for (const status of ["ACTIVE", "INACTIVE"] as const) {
  test(`Super Admin permanently deletes an unused ${status.toLowerCase()} employee and their sign-in account`, async ({
    page,
    context,
    browser,
  }) => {
    const target = await fixture("EMPLOYEE", status);
    const superAdmin = await fixture("SUPER_ADMIN");
    const employee = target.employee!;
    await authenticationRecords(target);
    const employeeContext = await browser.newContext();
    try {
      await signIn(employeeContext, target.id);
      if (status === "ACTIVE") {
        expect(
          (
            await employeeContext.request
              .get("/api/auth/session")
              .then((r) => r.json())
          ).user.id,
        ).toBe(target.id);
      }
      await signIn(context, superAdmin.id);
      await page.goto("/admin/employees");
      await page
        .getByRole("textbox", { name: "Search employees" })
        .fill(target.email);
      const row = page.getByRole("row").filter({ hasText: target.email });
      const remove = row.getByRole("button", {
        name: "Delete employee",
        exact: true,
      });
      await expect(remove).toBeVisible();
      await remove.click();
      const confirmation = page.getByRole("dialog", {
        name: "Delete employee?",
      });
      await expect(confirmation).toContainText("Permanently delete");
      await expect(confirmation).toContainText("sign-in account");
      await expect(confirmation).toContainText("deleted info");
      await confirmation
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      expect(await db.employee.count({ where: { id: employee.id } })).toBe(1);
      expect(await db.user.count({ where: { id: target.id } })).toBe(1);
      expect(await db.session.count({ where: { userId: target.id } })).toBe(1);
      await remove.click();
      await confirmation
        .getByRole("button", { name: "Delete employee", exact: true })
        .click();
      await expect(page.locator('.notice[role="status"]')).toContainText(
        "Employee and sign-in account permanently deleted.",
      );
      await expect(row).toHaveCount(0);
      expect(await db.employee.count({ where: { id: employee.id } })).toBe(0);
      expect(await db.user.count({ where: { id: target.id } })).toBe(0);
      expect(await db.account.count({ where: { userId: target.id } })).toBe(0);
      expect(await db.session.count({ where: { userId: target.id } })).toBe(0);
      expect(
        await db.passwordResetToken.count({ where: { userId: target.id } }),
      ).toBe(0);
      expect(
        await db.webAuthnCredential.count({
          where: { employeeId: employee.id },
        }),
      ).toBe(0);
      expect(
        await db.webAuthnChallenge.count({
          where: { employeeId: employee.id },
        }),
      ).toBe(0);
      expect(
        await db.auditLog.count({
          where: {
            actorId: superAdmin.id,
            action: "EMPLOYEE_DELETED",
            resourceId: employee.id,
          },
        }),
      ).toBe(1);
      expect(
        (await employeeContext.request.get("/api/attendance/me")).status(),
      ).toBe(401);
    } finally {
      await employeeContext.close();
    }
  });
}

test("employee deletion removes login access and displays retained attendance as deleted info", async ({
  page,
  context,
  browser,
}) => {
  const target = await fixture("EMPLOYEE");
  const superAdmin = await fixture("SUPER_ADMIN");
  const employee = target.employee!;
  await authenticationRecords(target);
  const shift = await db.shift.create({
    data: {
      name: `Delete shift ${employee.id}`,
      startTime: "09:00",
      endTime: "17:00",
    },
  });
  const attendance = await db.attendance.create({
    data: {
      employeeId: employee.id,
      officeId: employee.officeId,
      shiftId: shift.id,
      attendanceDate: new Date("2026-09-01"),
      status: "PRESENT",
    },
  });
  const leave = await db.leave.create({
    data: {
      employeeId: employee.id,
      startDate: new Date("2026-10-01"),
      endDate: new Date("2026-10-01"),
      reason: "Preserve employee history",
    },
  });
  const employeeContext = await browser.newContext();
  try {
    await signIn(employeeContext, target.id);
    await signIn(context, superAdmin.id);
    await page.goto("/admin/employees");
    await page
      .getByRole("textbox", { name: "Search employees" })
      .fill(target.email);
    const row = page.getByRole("row").filter({ hasText: target.email });
    const remove = row.getByRole("button", {
      name: "Delete employee",
      exact: true,
    });
    await expect(remove).toBeVisible();
    const response = page.waitForResponse(
      (res) =>
        res.request().method() === "DELETE" &&
        res.url().endsWith(`/api/admin/employees/${employee.id}`),
    );
    await remove.click();
    await page
      .getByRole("dialog", { name: "Delete employee?" })
      .getByRole("button", { name: "Delete employee", exact: true })
      .click();
    expect((await response).status()).toBe(200);
    await expect(row).toHaveCount(0);
    expect(await db.user.findUnique({ where: { id: target.id } })).toBeNull();
    expect(await db.employee.count({ where: { id: employee.id } })).toBe(0);
    expect(
      await db.attendance.findUnique({ where: { id: attendance.id } }),
    ).toMatchObject({
      employeeId: null,
      status: attendance.status,
      attendanceDate: attendance.attendanceDate,
    });
    expect(
      await db.leave.findUnique({ where: { id: leave.id } }),
    ).toMatchObject({ employeeId: null, reason: leave.reason });
    expect(await db.account.count({ where: { userId: target.id } })).toBe(0);
    expect(await db.session.count({ where: { userId: target.id } })).toBe(0);
    expect(
      await db.passwordResetToken.count({ where: { userId: target.id } }),
    ).toBe(0);
    expect(
      await db.webAuthnCredential.count({ where: { employeeId: employee.id } }),
    ).toBe(0);
    expect(
      await db.webAuthnChallenge.count({ where: { employeeId: employee.id } }),
    ).toBe(0);
    expect(
      await db.auditLog.count({
        where: { resourceId: employee.id, action: "EMPLOYEE_DELETED" },
      }),
    ).toBe(1);
    expect(
      (await employeeContext.request.get("/api/attendance/me")).status(),
    ).toBe(401);
    await page.goto(
      `/admin/attendance?from=2026-09-01&to=2026-09-01&officeId=${employee.officeId}`,
    );
    const history = page.getByRole("row").filter({ hasText: "deleted info" });
    await expect(history).toHaveCount(1);
    await expect(history).toContainText("present");
    await expect(
      history.getByRole("button", { name: "Correct attendance" }),
    ).toHaveCount(0);
  } finally {
    await employeeContext.close();
  }
});
