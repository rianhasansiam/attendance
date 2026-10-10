import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { test, expect, type BrowserContext } from "@playwright/test";
import { PrismaClient, type Role } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { testSessionCookie } from "./session-cookie";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
});

function documentXml(bytes: Buffer) {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("The downloaded DOCX has no ZIP directory.");
  let cursor = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    const size = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const name = bytes
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString();
    if (name === "word/document.xml") {
      const local = bytes.readUInt32LE(cursor + 42);
      const start =
        local +
        30 +
        bytes.readUInt16LE(local + 26) +
        bytes.readUInt16LE(local + 28);
      const compressed = bytes.subarray(start, start + size);
      return (
        bytes.readUInt16LE(cursor + 10) === 8
          ? inflateRawSync(compressed)
          : compressed
      ).toString();
    }
    cursor +=
      46 +
      nameLength +
      bytes.readUInt16LE(cursor + 30) +
      bytes.readUInt16LE(cursor + 32);
  }
  throw new Error("The downloaded DOCX has no editable document content.");
}

function expectBlankAcknowledgmentBeforeAttendance(xml: string) {
  const pageBreak = xml.indexOf('<w:br w:type="page"');
  expect(pageBreak).toBeGreaterThan(0);
  const summary = xml.slice(0, pageBreak);
  for (const label of [
    "Acknowledgment",
    "Employee acknowledgment",
    "Prepared by",
    "Signing acknowledges receipt and review of this statement only. It does not record payment or approval.",
  ])
    expect(summary).toContain(label);
  const acknowledgment = summary.slice(
    summary.indexOf("Employee acknowledgment"),
  );
  expect(
    acknowledgment.match(/<w:t(?:\s[^>]*)?>Signature _+<\/w:t>/g),
  ).toHaveLength(2);
  expect(acknowledgment.match(/<w:t(?:\s[^>]*)?>Date _+<\/w:t>/g)).toHaveLength(
    2,
  );
  expect(acknowledgment.match(/<w:t(?:\s[^>]*)?>Name _+<\/w:t>/g)).toHaveLength(
    1,
  );
  expect(xml.indexOf("Attendance Details")).toBeGreaterThan(pageBreak);
}

async function account(role: Role, name = "Salary browser user") {
  const unique = randomUUID();
  return db.user.create({
    data: {
      name,
      email: `salary-browser-${unique}@example.test`,
      role,
      googleAccountId: unique,
      accounts: {
        create: { type: "oidc", provider: "google", providerAccountId: unique },
      },
    },
  });
}
async function signIn(context: BrowserContext, userId: string) {
  const sessionToken = randomUUID();
  await db.session.create({
    data: { userId, sessionToken, expires: new Date(Date.now() + 3600000) },
  });
  await context.addCookies([
    {
      name: "authjs.session-token",
      value: await testSessionCookie(db, sessionToken),
      url: "http://localhost:3100",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}
test.afterAll(async () => db.$disconnect());

test("super admin configures effective rates, previews exact fractional overtime, downloads DOCX and recalculates stale sources", async ({
  page,
  context,
}) => {
  const admin = await account("SUPER_ADMIN", "Salary Super Admin");
  const member = await account(
    "EMPLOYEE",
    "Salary Employee Long Name for Browser Verification",
  );
  const code = `SAL-${randomUUID().slice(0, 8)}`;
  const office = await db.office.create({
    data: {
      name: code,
      address: "Fixture office",
      latitude: 0,
      longitude: 0,
      timezone: "Asia/Dhaka",
    },
  });
  const shift = await db.shift.create({
    data: {
      name: code,
      startTime: "08:30",
      endTime: "17:00",
      timezone: "Asia/Dhaka",
    },
  });
  const employee = await db.employee.create({
    data: {
      userId: member.id,
      employeeCode: code,
      officeId: office.id,
      joinedAt: new Date("2026-01-01"),
    },
  });
  const attendance = await db.attendance.create({
    data: {
      employeeId: employee.id,
      officeId: office.id,
      shiftId: shift.id,
      attendanceDate: new Date("2026-09-01"),
      status: "PRESENT",
      checkInAt: new Date("2026-09-01T02:30:00Z"),
      checkOutAt: new Date("2026-09-01T23:30:00Z"),
      scheduledStartAt: new Date("2026-09-01T02:30:00Z"),
      scheduledEndAt: new Date("2026-09-01T11:00:00Z"),
      workedMinutes: 1260,
      overtimeMinutes: 750,
    },
  });
  await signIn(context, admin.id);
  await page.goto(`/admin/salary-calculator?period=2026-09&search=${code}`);
  await expect(
    page.getByRole("heading", { name: "Salary calculator", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Salary calculator", exact: true }),
  ).toBeVisible();
  const row = page.locator("tbody tr").filter({ hasText: code });
  await expect(row).toContainText("Not configured");
  await expect(
    row.getByRole("button", { name: "Calculate", exact: true }),
  ).toBeDisabled();
  await expect(
    row.getByRole("button", { name: "Download DOCX", exact: true }),
  ).toBeDisabled();
  await row
    .getByRole("button", { name: "Salary settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Employee salary settings" });
  await dialog
    .getByLabel("Monthly reference salary (BDT)", { exact: true })
    .fill("30000");
  await dialog
    .getByLabel("Overtime hourly rate (BDT)", { exact: true })
    .fill("200");
  await dialog
    .getByRole("button", { name: "Save salary settings", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(row).toContainText("BDT 30,000.00");
  await row.getByRole("button", { name: "Calculate", exact: true }).click();
  await expect(row).toContainText("BDT 27,884.62");
  await expect(row).toContainText("BDT 25,384.62");
  await expect(row).toContainText("BDT 2,500.00");
  await row
    .getByRole("button", { name: "View breakdown", exact: true })
    .click();
  const breakdown = page.getByRole("dialog", { name: "Salary breakdown" });
  await expect(breakdown).toContainText("BDT 27,884.62");
  await expect(breakdown).toContainText("Payable days");
  await breakdown.getByRole("button", { name: /close/i }).click();
  const downloadEvent = page.waitForEvent("download");
  await row.getByRole("button", { name: "Download DOCX", exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe(
    `salary-statement-${code}-2026-09.docx`,
  );
  const file = await download.path();
  expect(file).toBeTruthy();
  const downloadedBytes = await readFile(file!);
  expect(downloadedBytes.subarray(0, 2).toString()).toBe("PK");
  const content = documentXml(downloadedBytes);
  expectBlankAcknowledgmentBeforeAttendance(content);
  for (const value of [
    code,
    member.name!,
    "BDT 30,000.00",
    "BDT 2,500.00",
    "BDT 25,384.62",
    "BDT 27,884.62",
    "12h 30m",
  ])
    expect(content).toContain(value);
  expect(content).not.toContain(admin.email);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelectorAll(".table-scroll").forEach((element) => {
      element.scrollLeft = 0;
    });
  });
  await page.screenshot({
    path: "test-results/salary-desktop.png",
    fullPage: true,
    animations: "disabled",
  });

  await db.attendance.update({
    where: { id: attendance.id },
    data: {
      checkOutAt: new Date("2026-09-01T23:00:00Z"),
      workedMinutes: 1230,
      overtimeMinutes: 720,
    },
  });
  const failed = page.waitForResponse((response) =>
    response.url().endsWith("/api/admin/salary/statement"),
  );
  await row.getByRole("button", { name: "Download DOCX", exact: true }).click();
  expect((await failed).status()).toBe(409);
  await expect(
    page.getByText(
      "Salary settings, attendance, or the office weekend policy changed, or this preview expired. Recalculate before downloading the statement.",
    ),
  ).toBeVisible();
  await expect(
    row.getByRole("button", { name: "Download DOCX", exact: true }),
  ).toBeDisabled();
  await row.getByRole("button", { name: "Calculate", exact: true }).click();
  await expect(row).toContainText("BDT 27,784.62");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/salary-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await row
    .getByRole("button", { name: "View breakdown", exact: true })
    .click();
  await expect(breakdown).toContainText("BDT 27,784.62");
  expect(
    await breakdown.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/salary-mobile-breakdown.png",
    animations: "disabled",
  });
  await breakdown.getByRole("button", { name: /close/i }).click();

  // A future revision never changes the selected historical month.
  const revision = await page.request.post("/api/admin/salary/settings", {
    headers: { origin: "http://localhost:3100" },
    data: {
      employeeId: employee.id,
      effectiveMonth: "2026-10",
      baseSalary: "40000",
      overtimeHourlyRate: "300",
    },
  });
  expect(revision.status()).toBe(200);
  const past = await page.request.post("/api/admin/salary/calculate", {
    headers: { origin: "http://localhost:3100" },
    data: { period: "2026-09", employeeIds: [employee.id] },
  });
  expect((await past.json()).data.items[0].totalSalary).toBe("27784.62");
});

test("range salary uses 18000 divided by 26 times nine payable days after excluding office weekends", async ({
  page,
  context,
}) => {
  const admin = await account("SUPER_ADMIN");
  const member = await account("EMPLOYEE", "Custom range salary employee");
  const code = `RANGE-${randomUUID().slice(0, 8)}`;
  const office = await db.office.create({
    data: {
      name: code,
      address: "Range fixture",
      latitude: 0,
      longitude: 0,
      timezone: "Asia/Dhaka",
      weekendDays: [5, 6],
    },
  });
  const shift = await db.shift.create({
    data: {
      name: code,
      startTime: "08:30",
      endTime: "17:00",
      timezone: "Asia/Dhaka",
    },
  });
  const employee = await db.employee.create({
    data: {
      userId: member.id,
      employeeCode: code,
      officeId: office.id,
      joinedAt: new Date("2026-01-01"),
    },
  });
  for (const [date, overtimeMinutes] of [
    ["2026-09-18", 600],
    ["2026-09-19", 600],
    ["2026-09-20", 90],
    ["2026-09-30", 30],
    ["2026-10-01", 600],
  ] as const) {
    const start = new Date(`${date}T02:30:00Z`);
    const end = new Date(`${date}T11:00:00Z`);
    await db.attendance.create({
      data: {
        employeeId: employee.id,
        officeId: office.id,
        shiftId: shift.id,
        attendanceDate: new Date(date),
        status: "PRESENT",
        checkInAt: start,
        checkOutAt: new Date(end.getTime() + overtimeMinutes * 60000),
        scheduledStartAt: start,
        scheduledEndAt: end,
        workedMinutes: 510 + overtimeMinutes,
        overtimeMinutes,
      },
    });
  }
  await signIn(context, admin.id);
  const saved = await page.request.post("/api/admin/salary/settings", {
    headers: { origin: "http://localhost:3100" },
    data: {
      employeeId: employee.id,
      effectiveMonth: "2026-09",
      baseSalary: "18000",
      overtimeHourlyRate: "200",
    },
  });
  expect(saved.status()).toBe(200);
  await page.goto(`/admin/salary-calculator?period=2026-09&search=${code}`);
  const row = page.locator("tbody tr").filter({ hasText: code });
  await expect(row).toContainText("BDT 18,000.00");
  await page.locator("#salary-from").fill("2026-09-20");
  await expect(page.locator("#salary-from")).toHaveValue("2026-09-20");
  await page.locator("#salary-to").fill("2026-09-30");
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(page).toHaveURL(/from=2026-09-20/);
  await expect(page).toHaveURL(/to=2026-09-30/);
  await row.getByRole("button", { name: "Calculate", exact: true }).click();
  await expect(row).toContainText("BDT 6,230.77");
  await expect(row).toContainText("BDT 6,630.77");
  await expect(row).toContainText("BDT 400.00");
  await row
    .getByRole("button", { name: "View breakdown", exact: true })
    .click();
  const breakdown = page.getByRole("dialog", { name: "Salary breakdown" });
  await expect(breakdown).toContainText("20");
  await expect(breakdown).toContainText("30");
  await expect(breakdown).toContainText("Sep");
  await expect(breakdown).toContainText("BDT 18,000.00");
  await expect(breakdown).toContainText("BDT 6,230.77");
  await expect(breakdown).toContainText("BDT 6,630.77");
  await expect(breakdown).toContainText("Fixed salary divisor");
  await expect(breakdown).toContainText("Calendar days (inclusive)");
  await expect(breakdown).toContainText("Excluded weekend days");
  await expect(breakdown).toContainText("Payable days");
  await expect(breakdown).toContainText("9 payable days");
  await page.screenshot({
    path: "test-results/salary-custom-range.png",
    fullPage: true,
    animations: "disabled",
  });
  await breakdown.getByRole("button", { name: /close/i }).click();
  const event = page.waitForEvent("download");
  await row.getByRole("button", { name: "Download DOCX", exact: true }).click();
  const downloaded = await event;
  expect(downloaded.suggestedFilename()).toBe(
    `salary-statement-${code}-2026-09-20-to-2026-09-30.docx`,
  );
  const xml = documentXml(await readFile((await downloaded.path())!));
  expectBlankAcknowledgmentBeforeAttendance(xml);
  expect(xml).toContain("BDT 18,000.00");
  expect(xml).toContain("BDT 6,230.77");
  expect(xml).toContain("BDT 6,630.77");
  expect(xml).toContain("20 Sept 2026");
  expect(xml).toContain("30 Sept 2026");
  expect(xml).not.toContain("18 Sept 2026");
  expect(xml).not.toContain("19 Sept 2026");
  expect(xml).not.toContain("01 Oct 2026");
  await page.locator("#salary-from").fill("2026-09-21");
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(
    row.getByRole("button", { name: "Download DOCX", exact: true }),
  ).toBeDisabled();
  await row.getByRole("button", { name: "Calculate", exact: true }).click();
  await expect(row).toContainText("BDT 5,538.46");
  await expect(row).toContainText("BDT 5,638.46");
});

for (const role of ["ADMIN", "EMPLOYEE", "MANAGE_DRIVER"] as const) {
  test(`${role} cannot open salary page or access any salary API`, async ({
    page,
    context,
  }) => {
    const user = await account(role);
    if (role !== "ADMIN") {
      await db.employee.create({
        data: {
          user: { connect: { id: user.id } },
          employeeCode: `DENIED-${randomUUID()}`,
          office: {
            create: {
              name: "Salary access fixture",
              address: "Test",
              latitude: 0,
              longitude: 0,
            },
          },
        },
      });
    }
    await signIn(context, user.id);
    await page.goto("/admin/salary-calculator");
    await expect(page).toHaveURL(/\/forbidden$/);
    expect(
      (await page.request.get("/api/admin/salary?period=2026-09")).status(),
    ).toBe(403);
    for (const endpoint of ["settings", "calculate", "statement"]) {
      expect(
        (
          await page.request.post(`/api/admin/salary/${endpoint}`, {
            headers: { origin: "http://localhost:3100" },
            data: {},
          })
        ).status(),
      ).toBe(403);
    }
    if (role === "ADMIN") {
      const audit = await db.auditLog.findFirstOrThrow({
        where: { resource: "salary-settings" },
      });
      const list = await page.request.get("/api/admin/audit?q=salary-settings");
      expect((await list.json()).data.items).toEqual([]);
      expect(
        (await page.request.get(`/api/admin/audit/${audit.id}`)).status(),
      ).toBe(403);
    }
  });
}
test("guests cannot open salary page or read private API data", async ({
  page,
}) => {
  await page.goto("/admin/salary-calculator");
  await expect(page).toHaveURL(/\/login$/);
  expect(
    (await page.request.get("/api/admin/salary?period=2026-09")).status(),
  ).toBe(401);
});
