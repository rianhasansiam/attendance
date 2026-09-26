import { testSessionCookie } from "./session-cookie";
import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
});
let adminId: string;

async function seedDriveCosts(context: BrowserContext) {
  const suffix = randomUUID();
  const admin = await db.user.create({
    data: {
      email: `drive-cost-filter-${suffix}@example.test`,
      name: "Drive Cost Filter Admin",
      role: "ADMIN",
      googleAccountId: suffix,
      accounts: {
        create: { type: "oidc", provider: "google", providerAccountId: suffix },
      },
    },
  });
  adminId = admin.id;
  await db.driveCost.createMany({
    data: Array.from({ length: 30 }, (_, index) => {
      const day = index + 1;
      return {
        date: new Date(`2024-09-${String(day).padStart(2, "0")}T00:00:00Z`),
        destinationFrom: `Trip ${String(day).padStart(2, "0")}`,
        destinationTo: day === 11 || day === 21 ? "Chattogram" : "Dhaka office",
        kilometers: "10.00",
        rateType: "IN_TIME" as const,
        ratePerKilometer: "5.00",
        totalCost: "50.00",
        createdById: admin.id,
      };
    }),
  });
  const token = randomUUID();
  await db.session.create({
    data: {
      userId: admin.id,
      sessionToken: token,
      expires: new Date(Date.now() + 3_600_000),
    },
  });
  await context.addCookies([
    {
      name: "authjs.session-token",
      value: await testSessionCookie(db, token),
      url: "http://localhost:3100",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

function recordList(page: Page) {
  return page.locator("section.card").filter({
    has: page.getByRole("form", { name: "Filter drive costs by date" }),
  });
}

async function filterDates(page: Page, from: string, to: string) {
  const filter = page.getByRole("form", { name: "Filter drive costs by date" });
  await filter.getByLabel("From date", { exact: true }).fill(from);
  await filter.getByLabel("To date", { exact: true }).fill(to);
  await filter.getByRole("button", { name: "Apply filters" }).click();
}

test.beforeEach(async ({ context }) => {
  await seedDriveCosts(context);
});

test.afterEach(async () => {
  if (!adminId) return;
  await db.driveCost.deleteMany({ where: { createdById: adminId } });
  await db.user.delete({ where: { id: adminId } });
});

test.afterAll(async () => {
  await db.$disconnect();
});

test("drive cost date filters include both boundaries and combine with search and pagination", async ({
  page,
}) => {
  await page.goto("/admin/drive-cost");
  const list = recordList(page);
  const filter = page.getByRole("form", { name: "Filter drive costs by date" });
  const search = page.getByRole("searchbox", { name: "Search drive costs" });
  await expect(list.locator("tbody tr")).toHaveCount(25);
  await expect(list).toContainText("Page 1 · 30 total records");
  await list.getByRole("button", { name: "Next", exact: true }).click();
  await expect(list.locator("tbody tr")).toHaveCount(5);
  await expect(list).toContainText("Page 2 · 30 total records");

  await filterDates(page, "2024-09-10", "2024-09-12");
  await expect(list).toContainText("Page 1 · 3 total records");
  await expect(list.locator("tbody tr")).toHaveCount(3);
  await expect(
    list.getByRole("cell", { name: "Trip 10", exact: true }),
  ).toBeVisible();
  await expect(
    list.getByRole("cell", { name: "Trip 12", exact: true }),
  ).toBeVisible();
  await expect(
    list.getByRole("button", { name: "Previous", exact: true }),
  ).toBeDisabled();

  await search.fill("Chattogram");
  await expect(list.locator("tbody tr")).toHaveCount(1);
  await expect(
    list.getByRole("cell", { name: "Trip 11", exact: true }),
  ).toBeVisible();
  await expect(list).toContainText("Page 1 · 1 total records");
  await search.fill("");
  await expect(list.locator("tbody tr")).toHaveCount(3);

  await filterDates(page, "2024-09-11", "2024-09-11");
  await expect(list.locator("tbody tr")).toHaveCount(1);
  await expect(
    list.getByRole("cell", { name: "Trip 11", exact: true }),
  ).toBeVisible();

  await filterDates(page, "2024-09-12", "");
  await expect(list.locator("tbody tr")).toHaveCount(19);
  await expect(
    list.getByRole("cell", { name: "Trip 12", exact: true }),
  ).toBeVisible();
  await filterDates(page, "", "2024-09-12");
  await expect(list.locator("tbody tr")).toHaveCount(12);
  await expect(
    list.getByRole("cell", { name: "Trip 12", exact: true }),
  ).toBeVisible();

  await filterDates(page, "2024-10-01", "2024-10-01");
  await expect(list).toContainText("Page 1 · 0 total records");
  await expect(
    list.getByText("Nothing here yet", { exact: true }),
  ).toBeVisible();
  await expect(
    list.getByRole("button", { name: "Next", exact: true }),
  ).toBeDisabled();
  await search.fill("Chattogram");
  await filter.getByRole("button", { name: "Reset filters" }).click();
  await expect(search).toHaveValue("");
  await expect(filter.getByLabel("From date", { exact: true })).toHaveValue("");
  await expect(filter.getByLabel("To date", { exact: true })).toHaveValue("");
  await expect(list).toContainText("Page 1 · 30 total records");
  await expect(list.locator("tbody tr")).toHaveCount(25);
  await filter.getByRole("button", { name: "Apply filters" }).click();
  await expect(list).toContainText("Page 1 · 30 total records");
});

test("drive cost date controls work on mobile independently from the calculator", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/drive-cost");
  const list = recordList(page);
  const filter = page.getByRole("form", { name: "Filter drive costs by date" });
  await filterDates(page, "2024-09-09", "2024-09-11");
  await expect(list.locator("tbody tr")).toHaveCount(3);
  await expect(list).toContainText("Page 1 · 3 total records");
  for (const control of [
    filter.getByLabel("From date", { exact: true }),
    filter.getByLabel("To date", { exact: true }),
    filter.getByRole("button", { name: "Apply filters" }),
    filter.getByRole("button", { name: "Reset filters" }),
  ]) {
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  await page.screenshot({
    path: "test-results/drive-cost-date-filter-mobile.png",
    fullPage: true,
  });

  await page
    .getByRole("button", { name: "Cost calculator", exact: true })
    .click();
  const calculator = page.locator("section.calc-card");
  await calculator.getByLabel("Date", { exact: true }).fill("2024-09-01");
  await calculator
    .getByRole("button", { name: "Calculate", exact: true })
    .click();
  await expect(calculator.locator("tbody tr")).toHaveCount(1);
  await expect(
    calculator.getByRole("cell", { name: "Trip 01", exact: true }),
  ).toBeVisible();
  await expect(list.locator("tbody tr")).toHaveCount(3);
  await expect(filter.getByLabel("From date", { exact: true })).toHaveValue(
    "2024-09-09",
  );
  await expect(filter.getByLabel("To date", { exact: true })).toHaveValue(
    "2024-09-11",
  );
});
