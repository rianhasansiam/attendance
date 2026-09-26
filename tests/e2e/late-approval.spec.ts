import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { PrismaClient, type Role } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
});
const origin = "http://localhost:3100";

async function user(role: Role, officeId?: string, shiftId?: string) {
  const suffix = randomUUID();
  return db.user.create({
    data: {
      name: `Late browser ${role} ${suffix.slice(0, 8)}`,
      email: `late-browser-${suffix}@example.test`,
      googleAccountId: suffix,
      role,
      accounts: {
        create: { type: "oidc", provider: "google", providerAccountId: suffix },
      },
      ...(officeId && shiftId
        ? {
            employee: {
              create: {
                employeeCode: suffix,
                officeId,
                joinedAt: new Date("2020-01-01T00:00:00Z"),
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
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

async function fixture(context: BrowserContext) {
  const suffix = randomUUID();
  const day = new Date().toISOString().slice(0, 10);
  const office = await db.office.create({
    data: {
      name: `Late approval office ${suffix}`,
      address: "Test office",
      latitude: 0,
      longitude: 0,
      timezone: "UTC",
      weekendDays: [],
      requireWebAuthn: false,
      requireApprovedDevice: false,
      requireGeofence: false,
      requireOfficeNetwork: false,
    },
  });
  const shift = await db.shift.create({
    data: {
      name: `Late browser shift ${suffix}`,
      startTime: "08:30",
      endTime: "17:00",
      timezone: "UTC",
      graceMinutes: 15,
    },
  });
  const employee = await user("EMPLOYEE", office.id, shift.id);
  const attendance = await db.attendance.create({
    data: {
      employeeId: employee.employee!.id,
      officeId: office.id,
      shiftId: shift.id,
      attendanceDate: new Date(`${day}T00:00:00Z`),
      scheduledStartAt: new Date(`${day}T08:30:00Z`),
      scheduledEndAt: new Date(`${day}T17:00:00Z`),
      checkInAt: new Date(`${day}T09:00:00Z`),
      checkOutAt: new Date(`${day}T17:30:00Z`),
      status: "LATE",
      lateMinutes: 30,
      workedMinutes: 510,
      overtimeMinutes: 30,
    },
  });
  await signIn(context, employee.id);
  return { employee, attendance, day };
}

async function review(
  page: Page,
  employeeName: string,
  decision: "Approve" | "Reject",
) {
  await page.goto("/admin/late-approvals");
  const row = page.getByRole("row").filter({ hasText: employeeName });
  await expect(row).toContainText("30");
  await row.getByRole("button", { name: "Review", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review late approval" });
  await expect(dialog).toContainText("30 minutes late");
  await dialog
    .getByLabel("Review note (optional)")
    .fill(`${decision} decision verified by the manager.`);
  await dialog.getByRole("button", { name: decision, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({
      hasText: `Late approval request ${decision === "Approve" ? "approved" : "rejected"}.`,
    }),
  ).toBeVisible();
}

test.afterAll(async () => {
  // Requests create immutable events and audits; retain fixtures in the disposable DB.
  await db.$disconnect();
});

for (const role of ["ADMIN", "SUPER_ADMIN"] as const) {
  test(`${role} reviews an employee's late reason and excuses history and exports without granting overtime`, async ({
    page,
    context,
  }) => {
    const value = await fixture(context);
    const reason = `Train delay approved ${randomUUID()}`;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/employee/dashboard");
    const dialog = page.getByRole("dialog", {
      name: "Reason for late attendance",
    });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Reason", { exact: true }).fill(reason);
    await dialog
      .getByRole("checkbox", { name: "Request late approval", exact: true })
      .check();
    await expect(dialog.locator("textarea")).toHaveCount(1);
    await page.screenshot({
      path: `test-results/late-approval-${role.toLowerCase()}-request.png`,
      fullPage: true,
    });
    await dialog
      .getByRole("button", { name: "Submit reason and request", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    const request = await db.lateApprovalRequest.findUniqueOrThrow({
      where: { attendanceId: value.attendance.id },
    });
    expect(request.status).toBe("PENDING");
    const denied = await context.request.patch(
      `/api/admin/late-approvals/${request.id}`,
      {
        data: { status: "APPROVED" },
        headers: { origin },
      },
    );
    expect(denied.status()).toBe(403);
    expect(
      (await context.request.get("/api/admin/late-approvals")).status(),
    ).toBe(403);
    await page.goto("/employee/history");
    const pending = page.getByRole("row").filter({ hasText: reason });
    await expect(pending).toContainText("pending");
    await expect(pending).toContainText("0h 0m");

    const admin = await user(role);
    await signIn(context, admin.id);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await review(page, value.employee.name!, "Approve");
    await page.getByLabel("Request status").selectOption("APPROVED");
    const approved = page
      .getByRole("row")
      .filter({ hasText: value.employee.name! });
    await approved.getByRole("button", { name: "View", exact: true }).click();
    const reviewed = page.getByRole("dialog", { name: "Review late approval" });
    await expect(reviewed).toContainText(admin.name!);
    await expect(
      reviewed.getByRole("button", { name: "Approve", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: `test-results/late-approval-${role.toLowerCase()}-review.png`,
      fullPage: true,
    });
    await reviewed.getByRole("button", { name: "Close dialog" }).click();

    const again = await context.request.patch(
      `/api/admin/late-approvals/${request.id}`,
      {
        data: { status: "REJECTED" },
        headers: { origin },
      },
    );
    expect(again.status()).toBe(409);
    const stored = await db.attendance.findUniqueOrThrow({
      where: { id: value.attendance.id },
    });
    expect(stored.checkInAt).toEqual(value.attendance.checkInAt);
    expect(stored.checkOutAt).toEqual(value.attendance.checkOutAt);
    expect(stored.lateMinutes).toBe(30);
    expect(stored.status).toBe("LATE");
    const params = new URLSearchParams({
      employeeId: value.employee.employee!.id,
      from: value.day,
      to: value.day,
    });
    const report = await context.request.get(`/api/admin/reports?${params}`);
    expect(report.ok()).toBe(true);
    const data = (await report.json()).data;
    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({
      status: "PRESENT",
      actualStatus: "LATE",
      effectiveLateMinutes: 0,
      lateMinutes: 30,
      lateApprovalStatus: "APPROVED",
      overtimeMinutes: 0,
    });
    expect(data.summary.overtimeMinutes).toBe(0);
    const lateReport = await context.request.get(
      `/api/admin/reports?${params}&status=LATE`,
    );
    expect((await lateReport.json()).data.total).toBe(0);

    if (role === "ADMIN") {
      const response = await context.request.get(
        `/api/admin/reports?${params}&format=pdf`,
      );
      expect(response.ok()).toBe(true);
      const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const task = getDocument({ data: new Uint8Array(await response.body()) });
      const pdf = await task.promise;
      try {
        const content = await (await pdf.getPage(1)).getTextContent();
        const text = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ");
        expect(text).toContain("Excused late");
        expect(text).toContain("PRESENT");
        expect(text).toContain("0h 0m");
        expect(text.replace(/\s/g, "")).toContain(reason.replace(/\s/g, ""));
      } finally {
        await task.destroy();
      }
    }

    await page.goto(`/admin/attendance?${params}`);
    await expect(
      page.getByRole("row").filter({ hasText: reason }),
    ).toContainText("Excused late · not counted");
    await signIn(context, value.employee.id);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/employee/history");
    const history = page.getByRole("row").filter({ hasText: reason });
    await expect(history).toContainText("Excused late · not counted");
    await expect(history).toContainText("Actual status: late");
    await expect(history).toContainText("0h 0m");
    await page.screenshot({
      path: `test-results/late-approval-${role.toLowerCase()}-history.png`,
      fullPage: true,
    });
  });
}

test("a rejected late request remains counted and cannot be finalized twice", async ({
  page,
  context,
}) => {
  const value = await fixture(context);
  const reason = `Unexcused delay ${randomUUID()}`;
  const response = await context.request.post("/api/attendance/late-reason", {
    data: { attendanceId: value.attendance.id, reason, requestApproval: true },
    headers: { origin },
  });
  expect(response.ok()).toBe(true);
  const request = await db.lateApprovalRequest.findUniqueOrThrow({
    where: { attendanceId: value.attendance.id },
  });
  const admin = await user("ADMIN");
  await signIn(context, admin.id);
  await review(page, value.employee.name!, "Reject");
  await page.getByLabel("Request status").selectOption("REJECTED");
  await expect(
    page.getByRole("row").filter({ hasText: value.employee.name! }),
  ).toContainText("rejected");
  const report = await context.request.get(
    `/api/admin/reports?employeeId=${value.employee.employee!.id}&from=${value.day}&to=${value.day}&status=LATE`,
  );
  expect((await report.json()).data.items[0]).toMatchObject({
    status: "LATE",
    effectiveLateMinutes: 30,
    lateApprovalStatus: "REJECTED",
    overtimeMinutes: 0,
  });
  const repeated = await context.request.patch(
    `/api/admin/late-approvals/${request.id}`,
    {
      data: { status: "APPROVED" },
      headers: { origin },
    },
  );
  expect(repeated.status()).toBe(409);
  await signIn(context, value.employee.id);
  await page.goto("/employee/history");
  const history = page.getByRole("row").filter({ hasText: reason });
  await expect(history).toContainText("rejected");
  await expect(history).not.toContainText("Excused late");
});
