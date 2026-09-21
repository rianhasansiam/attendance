import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { PrismaClient, type Role } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
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
      value: token,
      url: "http://localhost:3100",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

async function createUser(role: Role, officeId?: string, shiftId?: string) {
  const suffix = randomUUID();
  return db.user.create({
    data: {
      email: `overtime-${suffix}@example.test`,
      name: `Overtime ${role}`,
      role,
      googleAccountId: suffix,
      accounts: {
        create: { type: "oidc", provider: "google", providerAccountId: suffix },
      },
      ...(officeId && shiftId
        ? {
            employee: {
              create: {
                employeeCode: suffix,
                officeId,
                shifts: {
                  create: {
                    shiftId,
                    startDate: new Date("2020-01-01T00:00:00Z"),
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

async function expectOvertimeTable(page: Page, overtime: string) {
  await expect(
    page.getByRole("columnheader", { name: "Overtime", exact: true }),
  ).toBeVisible();
  const columns = await page.getByRole("columnheader").allTextContents();
  const overtimeColumn = columns.indexOf("Overtime");
  for (const [reason, expected] of [
    ["Overtime browser checkout", overtime],
    ["Unknown historical overtime", "—"],
    ["No overtime worked", "0h 0m"],
  ]) {
    const row = page.getByRole("row").filter({ hasText: reason });
    await expect(row.getByRole("cell").nth(overtimeColumn)).toHaveText(
      expected,
    );
  }
}

test.afterAll(async () => {
  await db.$disconnect();
});

test("late checkout records overtime and displays hours in employee and admin attendance", async ({
  page,
  context,
}) => {
  const suffix = randomUUID();
  const office = await db.office.create({
    data: {
      name: `Overtime office ${suffix}`,
      address: "Test office",
      latitude: 23.8,
      longitude: 90.4,
      timezone: "UTC",
      requireWebAuthn: false,
      requireApprovedDevice: false,
      requireGeofence: false,
      requireOfficeNetwork: false,
    },
  });
  const now = Date.now();
  const checkInAt = new Date(now - 9 * 60 * 60_000);
  const scheduledEndAt = new Date(now - 90 * 60_000);
  const businessDate = new Date(
    `${checkInAt.toISOString().slice(0, 10)}T00:00:00Z`,
  );
  const shift = await db.shift.create({
    data: {
      name: `Overtime shift ${suffix}`,
      startTime: checkInAt.toISOString().slice(11, 16),
      endTime: scheduledEndAt.toISOString().slice(11, 16),
      timezone: "UTC",
    },
  });
  const employee = await createUser("EMPLOYEE", office.id, shift.id);
  const employeeId = employee.employee!.id;
  const common = { employeeId, officeId: office.id, shiftId: shift.id };
  const attendance = await db.attendance.create({
    data: {
      ...common,
      attendanceDate: businessDate,
      checkInAt,
      scheduledEndAt,
      status: "PRESENT",
      lateReason: "Overtime browser checkout",
    },
  });
  const historicalCheckIn = new Date(checkInAt.getTime() - 2 * 86_400_000);
  const historicalCheckOut = new Date(
    historicalCheckIn.getTime() + 8 * 60 * 60_000,
  );
  await db.attendance.create({
    data: {
      ...common,
      attendanceDate: new Date(businessDate.getTime() - 2 * 86_400_000),
      checkInAt: historicalCheckIn,
      checkOutAt: historicalCheckOut,
      status: "PRESENT",
      workedMinutes: 480,
      overtimeMinutes: null,
      lateReason: "Unknown historical overtime",
    },
  });
  await db.attendance.create({
    data: {
      ...common,
      attendanceDate: new Date(businessDate.getTime() - 86_400_000),
      checkInAt: new Date(historicalCheckIn.getTime() + 86_400_000),
      checkOutAt: new Date(historicalCheckOut.getTime() + 86_400_000),
      scheduledEndAt: new Date(historicalCheckOut.getTime() + 86_400_000),
      status: "PRESENT",
      workedMinutes: 480,
      overtimeMinutes: 0,
      lateReason: "No overtime worked",
    },
  });

  // A later schedule edit must not alter the recorded overtime boundary.
  await db.shift.update({
    where: { id: shift.id },
    data: {
      endTime: new Date(now + 3 * 60 * 60_000).toISOString().slice(11, 16),
    },
  });
  await signIn(context, employee.id);
  await page.goto("/employee/dashboard");
  await page.getByRole("button", { name: "Check out", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "You’re checked out" }),
  ).toBeVisible();
  const checkedOut = await db.attendance.findUniqueOrThrow({
    where: { id: attendance.id },
  });
  expect(checkedOut.checkOutAt).not.toBeNull();
  expect(checkedOut.scheduledEndAt).toEqual(scheduledEndAt);
  const overtimeMinutes = Math.floor(
    (checkedOut.checkOutAt!.getTime() - scheduledEndAt.getTime()) / 60_000,
  );
  expect(overtimeMinutes).toBeGreaterThanOrEqual(90);
  expect(checkedOut.overtimeMinutes).toBe(overtimeMinutes);
  const displayedOvertime = `${Math.floor(overtimeMinutes / 60)}h ${overtimeMinutes % 60}m`;
  await expectOvertimeTable(page, displayedOvertime);

  await page.goto("/employee/history");
  await expectOvertimeTable(page, displayedOvertime);
  await page.screenshot({
    path: "test-results/overtime-employee.png",
    fullPage: true,
  });

  const admin = await createUser("ADMIN");
  await signIn(context, admin.id);
  await page.goto(`/admin/attendance?employeeId=${employeeId}`);
  await expectOvertimeTable(page, displayedOvertime);
  await page
    .getByRole("columnheader", { name: "Overtime", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "test-results/overtime-admin.png",
    fullPage: true,
  });
});
