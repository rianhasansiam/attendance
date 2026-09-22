import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  test,
  expect,
  type BrowserContext,
  type Download,
} from "@playwright/test";
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

async function user(role: Role, officeId?: string) {
  const suffix = randomUUID();
  const result = await db.user.create({
    data: {
      name:
        role === "EMPLOYEE" ? "রহিম Ahmed PDF Employee" : "PDF Report Admin",
      email: `pdf-report-${suffix}@example.test`,
      role,
      googleAccountId: suffix,
      accounts: {
        create: { type: "oidc", provider: "google", providerAccountId: suffix },
      },
      ...(officeId
        ? {
            employee: {
              create: {
                employeeCode: `PDF-${suffix.slice(0, 8)}`,
                officeId,
                joinedAt: new Date("2020-01-01T00:00:00Z"),
              },
            },
          }
        : {}),
    },
    include: { employee: true },
  });
  fixtures.users.push(result.id);
  if (result.employee) fixtures.employees.push(result.employee.id);
  return result;
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
      url: "http://localhost:3100",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

async function pdfText(download: Download, path: string) {
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  await download.saveAs(path);
  const bytes = await readFile(path);
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await getDocument({ data: new Uint8Array(bytes) }).promise;
  try {
    const pages = await Promise.all(
      Array.from({ length: document.numPages }, async (_, index) => {
        const page = await document.getPage(index + 1);
        const content = await page.getTextContent();
        return content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ");
      }),
    );
    return { text: pages.join(" "), pages: document.numPages };
  } finally {
    await document.destroy();
  }
}

function mayDay(day: number) {
  return `2023-05-${String(day).padStart(2, "0")}`;
}

test.afterEach(async () => {
  const employeeId = { in: fixtures.employees };
  const userId = { in: fixtures.users };
  await db.$transaction([
    db.driveCost.deleteMany({ where: { createdById: userId } }),
    db.attendance.deleteMany({ where: { employeeId } }),
    db.employeeShift.deleteMany({ where: { employeeId } }),
    db.employee.deleteMany({ where: { id: employeeId } }),
    db.user.deleteMany({ where: { id: userId } }),
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

test("attendance PDF downloads all filtered pages with exact minute totals", async ({
  page,
  context,
}) => {
  const office = await db.office.create({
    data: {
      name: "Dhaka PDF Office ঢাকা",
      address: "Test office",
      latitude: 23.8,
      longitude: 90.4,
      timezone: "Asia/Dhaka",
    },
  });
  fixtures.offices.push(office.id);
  const shift = await db.shift.create({
    data: {
      name: "Day shift",
      startTime: "09:00",
      endTime: "17:00",
      timezone: "Asia/Dhaka",
    },
  });
  fixtures.shifts.push(shift.id);
  const employee = await user("EMPLOYEE", office.id);
  const otherEmployee = await user("EMPLOYEE", office.id);
  await db.user.update({
    where: { id: otherEmployee.id },
    data: { name: "Excluded PDF Employee" },
  });
  const rows = Array.from({ length: 30 }, (_, index) => {
    const date = mayDay(index + 1);
    return {
      employeeId: employee.employee!.id,
      officeId: office.id,
      shiftId: shift.id,
      attendanceDate: new Date(`${date}T00:00:00Z`),
      checkInAt: new Date(`${date}T03:00:00Z`),
      checkOutAt: new Date(`${date}T11:40:00Z`),
      scheduledEndAt: index === 29 ? null : new Date(`${date}T11:00:00Z`),
      overtimeMinutes: index === 29 ? null : 40,
      workedMinutes: 520,
      status: "PRESENT" as const,
      lateReason:
        index === 0
          ? "Long report note: " + "Verified attendance details. ".repeat(25)
          : `Attendance record ${String(index + 1).padStart(2, "0")}`,
    };
  });
  await db.attendance.createMany({ data: rows });
  await db.attendance.create({
    data: { ...rows[0], employeeId: otherEmployee.employee!.id },
  });
  const admin = await user("ADMIN");
  await signIn(context, admin.id);
  await page.goto("/admin/reports");
  await page
    .getByLabel("Employee", { exact: true })
    .selectOption(employee.employee!.id);
  await page.getByLabel("From date", { exact: true }).fill(mayDay(1));
  await page.getByLabel("To date", { exact: true }).fill(mayDay(30));
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(
    page.getByRole("region", { name: "Overtime summary" }),
  ).toContainText("19h 20m");
  await expect(page.locator("tbody tr")).toHaveCount(25);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(5);
  await expect(page.getByRole("link", { name: /^(CSV|Excel)$/ })).toHaveCount(
    0,
  );
  const downloadEvent = page.waitForEvent("download");
  const responseEvent = page.waitForResponse((response) =>
    response.url().includes("format=pdf"),
  );
  await page.getByRole("button", { name: "Download PDF", exact: true }).click();
  const response = await responseEvent;
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/pdf");
  const report = await pdfText(
    await downloadEvent,
    "test-results/attendance-report.pdf",
  );
  expect(report.pages).toBeGreaterThan(1);
  expect(report.text).toContain("19h 20m");
  expect(report.text).toContain("0h 40m");
  expect(report.text).toContain("Ahmed PDF Employee");
  expect(report.text).not.toContain("Excluded PDF Employee");
  expect(report.text).toContain("Long report note:");
  for (let day = 2; day <= 30; day++) {
    expect(report.text).toContain(
      `Attendance record ${String(day).padStart(2, "0")}`,
    );
  }
  await page.screenshot({
    path: "test-results/attendance-pdf-page.png",
    fullPage: true,
  });
});

test("drive cost PDF includes the date and search filters, all pages and calculator dates on mobile", async ({
  page,
  context,
}) => {
  const admin = await user("ADMIN");
  const marker = `PDF-route-${randomUUID().slice(0, 8)}`;
  const rows = Array.from({ length: 30 }, (_, index) => ({
    date: new Date(`${mayDay(index + 1)}T00:00:00Z`),
    destinationFrom: `${marker} Trip ${String(index + 1).padStart(2, "0")} ঢাকা`,
    destinationTo:
      index === 0
        ? "Gazipur warehouse loading area, followed by the main Dhaka distribution center and delivery office গাজীপুর"
        : "Dhaka office",
    kilometers: "12.50",
    rateType: index % 2 === 0 ? ("IN_TIME" as const) : ("OVER_TIME" as const),
    ratePerKilometer: index % 2 === 0 ? "5.00" : "10.00",
    totalCost: index % 2 === 0 ? "62.50" : "125.00",
    createdById: admin.id,
  }));
  await db.driveCost.createMany({ data: rows });
  await db.driveCost.createMany({
    data: [
      {
        ...rows[0],
        date: new Date("2023-06-01T00:00:00Z"),
        destinationTo: "Outside date range",
      },
      {
        ...rows[0],
        date: new Date("2023-05-15T00:00:00Z"),
        destinationFrom: "Excluded search destination",
      },
    ],
  });
  await signIn(context, admin.id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/drive-cost");
  const form = page.getByRole("form", { name: "Filter drive costs by date" });
  const list = page.locator("section.card").filter({ has: form });
  await page
    .getByRole("searchbox", { name: "Search drive costs" })
    .fill(marker);
  await form.getByLabel("From date", { exact: true }).fill(mayDay(1));
  await form.getByLabel("To date", { exact: true }).fill(mayDay(30));
  await form.getByRole("button", { name: "Apply filters" }).click();
  await expect(list).toContainText("Page 1 · 30 total records");
  await list.getByRole("button", { name: "Next", exact: true }).click();
  await expect(list).toContainText("Page 2 · 30 total records");
  const button = page.getByRole("button", {
    name: "Download PDF",
    exact: true,
  });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  const responseEvent = page.waitForResponse((response) =>
    response.url().includes("/api/admin/drive-costs/report?"),
  );
  const downloadEvent = page.waitForEvent("download");
  await button.click();
  const response = await responseEvent;
  const url = new URL(response.url());
  expect(url.searchParams.get("q")).toBe(marker);
  expect(url.searchParams.get("from")).toBe(mayDay(1));
  expect(url.searchParams.get("to")).toBe(mayDay(30));
  expect(url.searchParams.has("page")).toBe(false);
  expect(response.headers()["content-type"]).toBe("application/pdf");
  const report = await pdfText(
    await downloadEvent,
    "test-results/drive-cost-report.pdf",
  );
  expect(report.pages).toBeGreaterThan(1);
  expect(report.text).toMatch(/2,?812\.50/);
  expect(report.text).toMatch(/375(?:\.00)?/);
  expect(report.text).not.toContain("Outside date range");
  expect(report.text).not.toContain("Excluded search destination");
  for (let day = 1; day <= 30; day++) {
    expect(report.text).toContain(`Trip ${String(day).padStart(2, "0")}`);
  }
  await page.screenshot({
    path: "test-results/drive-cost-pdf-mobile.png",
    fullPage: true,
  });

  await page
    .getByRole("button", { name: "Cost calculator", exact: true })
    .click();
  const calculator = page.locator("section.calc-card");
  await calculator.getByLabel("Date", { exact: true }).fill(mayDay(2));
  await calculator
    .getByRole("button", { name: "Calculate", exact: true })
    .click();
  await expect(calculator.locator("tbody tr")).toHaveCount(1);
  // Download the displayed result even if an unapplied date draft is changed.
  await calculator.getByLabel("Date", { exact: true }).fill(mayDay(3));
  const calculatorDownload = page.waitForEvent("download");
  await calculator
    .getByRole("button", { name: "Download PDF", exact: true })
    .click();
  const calculated = await pdfText(
    await calculatorDownload,
    "test-results/drive-cost-calculator-report.pdf",
  );
  expect(calculated.text).toContain("Trip 02");
  expect(calculated.text).not.toContain("Trip 03");
  expect(calculated.text).toContain("125.00");
});
