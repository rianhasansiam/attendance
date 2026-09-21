import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { PrismaClient, type Role } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
});
const fixtures = {
  users: [] as string[],
  employees: [] as string[],
  offices: [] as string[],
  shifts: [] as string[],
};

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

test.afterEach(async () => {
  // Only the summary fixtures are mutable. The checkout test creates immutable
  // attendance history and relies on the disposable database for isolation.
  if (!fixtures.offices.length) return;
  const employeeId = { in: fixtures.employees };
  await db.$transaction([
    db.attendance.deleteMany({ where: { employeeId } }),
    db.employeeShift.deleteMany({ where: { employeeId } }),
    db.employee.deleteMany({ where: { id: employeeId } }),
    db.user.deleteMany({ where: { id: { in: fixtures.users } } }),
    db.shift.deleteMany({ where: { id: { in: fixtures.shifts } } }),
    db.office.deleteMany({ where: { id: { in: fixtures.offices } } }),
    db.rateLimit.deleteMany({
      where: { key: { in: fixtures.users.map((id) => `reports:${id}`) } },
    }),
  ]);
  for (const ids of Object.values(fixtures)) ids.length = 0;
});

test.afterAll(async () => {
  await db.$disconnect();
});

for (const expectedMinutes of [40, 90]) {
  test(`late checkout records ${expectedMinutes} overtime minutes in employee, admin and report totals`, async ({
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
    const scheduledEndAt = new Date(now - expectedMinutes * 60_000);
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
    expect(overtimeMinutes).toBe(expectedMinutes);
    expect(checkedOut.overtimeMinutes).toBe(overtimeMinutes);
    const displayedOvertime = `${Math.floor(overtimeMinutes / 60)}h ${overtimeMinutes % 60}m`;
    await expectOvertimeTable(page, displayedOvertime);

    await page.goto("/employee/history");
    await expectOvertimeTable(page, displayedOvertime);
    await page.screenshot({
      path: `test-results/overtime-${expectedMinutes}m-employee.png`,
      fullPage: true,
    });

    const admin = await createUser("ADMIN");
    await signIn(context, admin.id);
    await page.goto(`/admin/attendance?employeeId=${employeeId}`);
    await expectOvertimeTable(page, displayedOvertime);
    await expect(
      page.getByRole("region", { name: "Overtime summary" }),
    ).toContainText(displayedOvertime);
    await page
      .getByRole("columnheader", { name: "Overtime", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/overtime-${expectedMinutes}m-admin.png`,
      fullPage: true,
    });

    await page.goto("/admin/reports");
    await page.getByLabel("Employee", { exact: true }).selectOption(employeeId);
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expectOvertimeTable(page, displayedOvertime);
    await expect(
      page.getByRole("region", { name: "Overtime summary" }),
    ).toContainText(displayedOvertime);
    await page
      .getByRole("columnheader", { name: "Overtime", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/overtime-${expectedMinutes}m-reports.png`,
      fullPage: true,
    });
  });
}

test("filtered overtime includes every page and resets consistently in attendance and reports", async ({
  page,
  context,
}) => {
  const suffix = randomUUID();
  const office = await db.office.create({
    data: {
      name: `Overtime totals office ${suffix}`,
      address: "Test office",
      latitude: 23.8,
      longitude: 90.4,
      timezone: "UTC",
    },
  });
  fixtures.offices.push(office.id);
  const shift = await db.shift.create({
    data: {
      name: `Overtime totals shift ${suffix}`,
      startTime: "09:00",
      endTime: "17:00",
      timezone: "UTC",
    },
  });
  fixtures.shifts.push(shift.id);
  const employee = await createUser("EMPLOYEE", office.id, shift.id);
  fixtures.users.push(employee.id);
  fixtures.employees.push(employee.employee!.id);
  const otherEmployee = await createUser("EMPLOYEE", office.id, shift.id);
  fixtures.users.push(otherEmployee.id);
  fixtures.employees.push(otherEmployee.employee!.id);
  const employeeId = employee.employee!.id;
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const dateBefore = (days: number) =>
    new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = Array.from({ length: 29 }, (_, index) => {
    const days = index + 1;
    const day = dateBefore(days);
    // The large amount is on page two; summing only visible rows would give 25m.
    const overtimeMinutes = days === 29 ? null : days === 28 ? 61 : 1;
    const scheduledEndAt = new Date(`${day}T17:00:00Z`);
    return {
      employeeId,
      officeId: office.id,
      shiftId: shift.id,
      attendanceDate: new Date(`${day}T00:00:00Z`),
      checkInAt: new Date(`${day}T09:00:00Z`),
      checkOutAt: new Date(
        scheduledEndAt.getTime() + (overtimeMinutes ?? 0) * 60_000,
      ),
      scheduledEndAt: overtimeMinutes === null ? null : scheduledEndAt,
      workedMinutes: 480 + (overtimeMinutes ?? 0),
      overtimeMinutes,
      status: days % 2 === 0 ? ("LATE" as const) : ("PRESENT" as const),
    };
  });
  await db.attendance.createMany({ data: rows });
  await db.attendance.create({
    data: {
      ...rows[0],
      employeeId: otherEmployee.employee!.id,
      checkOutAt: new Date(`${dateBefore(1)}T19:05:00Z`),
      workedMinutes: 605,
      overtimeMinutes: 125,
    },
  });

  const admin = await createUser("ADMIN");
  fixtures.users.push(admin.id);
  await signIn(context, admin.id);
  const baselineResponse = await context.request.get("/api/admin/reports");
  expect(baselineResponse.ok()).toBeTruthy();
  const baseline = (await baselineResponse.json()).data;
  const baselineMinutes = baseline.summary.overtimeMinutes;
  expect(baselineMinutes).toBeGreaterThanOrEqual(213);
  const baselineDuration = `${Math.floor(baselineMinutes / 60)}h ${baselineMinutes % 60}m`;

  for (const route of ["attendance", "reports"]) {
    await page.goto(
      route === "attendance"
        ? `/admin/attendance?employeeId=${employeeId}`
        : "/admin/reports",
    );
    const summary = page.getByRole("region", { name: "Overtime summary" });
    const employeeFilter = page.getByLabel("Employee", { exact: true });
    if (route === "attendance") {
      await expect(employeeFilter).toHaveValue(employeeId);
      await expect(summary).toContainText("1h 28m");
    } else {
      await employeeFilter.selectOption(employeeId);
    }
    await page.getByLabel("From date").fill(dateBefore(29));
    await page.getByLabel("To date").fill(dateBefore(1));
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(summary).toContainText("1h 28m");
    await expect(summary).toContainText("Across all 29 matching records");
    await expect(summary).toContainText(
      "Excludes 1 record with unknown overtime",
    );
    await expect(page.locator("tbody tr")).toHaveCount(25);

    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText("Page 2 · Times shown")).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(4);
    await expect(summary).toContainText("1h 28m");
    await expect(summary).toContainText("Across all 29 matching records");
    await page.screenshot({
      path: `test-results/overtime-total-${route}.png`,
      fullPage: true,
    });

    await page.getByLabel("From date").fill(dateBefore(3));
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(summary).toContainText("0h 3m");
    await expect(summary).toContainText("Across all 3 matching records");
    await expect(summary).not.toContainText("Excludes");
    await expect(page.getByText("Page 1 · Times shown")).toBeVisible();
    await page.getByLabel("Status", { exact: true }).selectOption("LATE");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(summary).toContainText("0h 1m");
    await expect(page.locator("tbody tr")).toHaveCount(1);

    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(employeeFilter).toHaveValue("");
    await expect(page.getByLabel("From date")).toHaveValue("");
    await expect(page.getByLabel("To date")).toHaveValue("");
    await expect(page.getByLabel("Status", { exact: true })).toHaveValue("");
    await expect(summary).toContainText(baselineDuration);
    await expect(summary).toContainText(
      `Across all ${baseline.total} matching records`,
    );
    // Reapplying after reset must not restore a hidden employee selection.
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(summary).toContainText(baselineDuration);
  }
});
