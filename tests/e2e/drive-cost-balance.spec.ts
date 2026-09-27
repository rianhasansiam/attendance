import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { testSessionCookie } from "./session-cookie";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
});
let userId: string | undefined;
let route: string;

type Balance = { balance: string; totalAdded: string; totalPaid: string };

function taka(value: number) {
  return `${value < 0 ? "-" : ""}৳${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function balanceSummary(page: Page, label: string) {
  return page
    .getByRole("region", { name: "Drive cost balance", exact: true })
    .locator(".calc-summary-card")
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator("strong");
}

async function readBalance(page: Page): Promise<Balance> {
  const response = await page.request.get("/api/admin/drive-costs/balance");
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}

test.beforeEach(async ({ context }) => {
  const suffix = randomUUID();
  route = `Balance trip ${suffix}`;
  const account = await db.user.create({
    data: {
      email: `drive-balance-${suffix}@example.test`,
      name: "Drive Balance Admin",
      role: "SUPER_ADMIN",
      googleAccountId: suffix,
      accounts: {
        create: { type: "oidc", provider: "google", providerAccountId: suffix },
      },
      employee: {
        create: {
          employeeCode: `BAL-${suffix}`,
          office: {
            create: {
              name: `Drive Balance Office ${suffix}`,
              address: "Test office",
              latitude: 23.8,
              longitude: 90.4,
            },
          },
        },
      },
    },
  });
  userId = account.id;
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
      url: "http://localhost:3100",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
});

test.afterEach(async () => {
  if (!userId) return;
  await db.driveCost.deleteMany({ where: { createdById: userId } });
  await db.driveCostBalanceAddition.deleteMany({
    where: { createdById: userId },
  });
  await db.session.deleteMany({ where: { userId } });
  // Audit history is immutable; retain its referenced user in the disposable DB.
  userId = undefined;
});

test.afterAll(async () => {
  await db.$disconnect();
});

test("super admins fund the shared balance, paid trips can overdraw it, and other roles cannot add funds", async ({
  page,
}) => {
  const initial = await readBalance(page);
  const initialBalance = Number(initial.balance);
  const tripKilometers = Math.ceil(Math.max(100, initialBalance + 130) / 5.5);
  const tripCost = tripKilometers * 5.5;
  await db.driveCost.createMany({
    data: [
      {
        date: new Date("2024-01-01T00:00:00Z"),
        destinationFrom: "Previously paid balance trip",
        destinationTo: route,
        kilometers: "10.00",
        rateType: "IN_TIME",
        ratePerKilometer: "5.00",
        totalCost: "50.00",
        paymentStatus: "PAID",
        createdById: userId!,
      },
      {
        date: new Date("2031-04-17T00:00:00Z"),
        destinationFrom: route,
        destinationTo: "Client destination",
        kilometers: tripKilometers.toFixed(2),
        rateType: "IN_TIME",
        ratePerKilometer: "5.50",
        totalCost: tripCost.toFixed(2),
        createdById: userId!,
      },
    ],
  });

  await page.goto("/admin/drive-cost");
  const balance = page.getByRole("region", {
    name: "Drive cost balance",
    exact: true,
  });
  const currentBalance = balanceSummary(page, "Current balance");
  await expect(currentBalance).toHaveText(taka(initialBalance - 50));
  await expect(balanceSummary(page, "Paid trips")).toHaveText(
    taka(Number(initial.totalPaid) + 50),
  );
  const funding = balance.getByRole("form", { name: "Add drive cost balance" });
  await funding.getByLabel("Amount (BDT)", { exact: true }).fill("80.00");
  await funding
    .getByLabel("Note (optional)", { exact: true })
    .fill("Fuel advance");
  const additionResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/admin/drive-costs/balance"),
  );
  await funding
    .getByRole("button", { name: "Add balance", exact: true })
    .click();
  expect((await additionResponse).status()).toBe(200);
  await expect(currentBalance).toHaveText(taka(initialBalance + 30));
  await expect(balanceSummary(page, "Total added")).toHaveText(
    taka(Number(initial.totalAdded) + 80),
  );
  const addition = await db.driveCostBalanceAddition.findFirstOrThrow({
    where: { createdById: userId },
  });
  expect(addition.amount.toFixed(2)).toBe("80.00");
  expect(addition.note).toBe("Fuel advance");

  // Balance includes all dates even when the records list is narrowed to one trip.
  const filter = page.getByRole("form", { name: "Filter drive costs by date" });
  await filter.getByLabel("From date", { exact: true }).fill("2031-04-17");
  await filter.getByLabel("To date", { exact: true }).fill("2031-04-17");
  await filter.getByRole("button", { name: "Apply filters" }).click();
  await page.getByRole("searchbox", { name: "Search drive costs" }).fill(route);
  const list = page.locator("section.card").filter({ has: filter });
  await expect(list.locator("tbody tr")).toHaveCount(1);
  await expect(currentBalance).toHaveText(taka(initialBalance + 30));
  const statusButton = (status: "paid" | "unpaid") =>
    list.getByRole("button", {
      name: `Mark ${status} for drive cost from ${route} to Client destination`,
      exact: true,
    });
  await statusButton("paid").click();
  await expect(statusButton("unpaid")).toBeVisible();
  const negativeBalance = initialBalance + 30 - tripCost;
  expect(negativeBalance).toBeLessThan(0);
  await expect(currentBalance).toHaveText(taka(negativeBalance));
  await expect(balanceSummary(page, "Paid trips")).toHaveText(
    taka(Number(initial.totalPaid) + 50 + tripCost),
  );
  await page.reload();
  await expect(currentBalance).toHaveText(taka(negativeBalance));
  await page.screenshot({
    path: "test-results/drive-cost-negative-balance-desktop.png",
    animations: "disabled",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  // Resizing starts the shell's closing transition; wait until the drawer
  // has fully left the viewport before checking or capturing the balance.
  await expect(page.locator(".sidebar")).not.toHaveClass(/is-open/);
  await expect
    .poll(() =>
      page
        .locator(".sidebar")
        .evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(0);
  await expect(currentBalance).toBeVisible();
  await currentBalance.click({ trial: true });
  const box = await currentBalance.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/drive-cost-negative-balance-mobile.png",
    animations: "disabled",
    fullPage: true,
  });

  await statusButton("unpaid").click();
  await expect(statusButton("paid")).toBeVisible();
  await expect(currentBalance).toHaveText(taka(initialBalance + 30));
  const restored = await readBalance(page);
  expect(Number(restored.balance)).toBe(initialBalance + 30);
  expect(Number(restored.totalPaid)).toBe(Number(initial.totalPaid) + 50);

  for (const role of ["ADMIN", "MANAGE_DRIVER"] as const) {
    await db.user.update({ where: { id: userId }, data: { role } });
    await page.goto(
      role === "ADMIN" ? "/admin/drive-cost" : "/employee/drive-cost",
    );
    await expect(currentBalance).toHaveText(taka(initialBalance + 30));
    await expect(
      balance.getByRole("form", { name: "Add drive cost balance" }),
    ).toHaveCount(0);
    await expect(
      balance.getByRole("button", { name: "Add balance", exact: true }),
    ).toHaveCount(0);
    const rejected = await page.request.post("/api/admin/drive-costs/balance", {
      data: {
        requestId: randomUUID(),
        amount: "10.00",
        note: "Unauthorized addition",
      },
      headers: { Origin: "http://localhost:3100" },
    });
    expect(rejected.status()).toBe(403);
    expect(await readBalance(page)).toEqual(restored);
  }
  expect(
    await db.driveCostBalanceAddition.count({ where: { createdById: userId } }),
  ).toBe(1);
});
