import { testSessionCookie } from "./session-cookie";
import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
});
const tripDate = "2031-04-17";
let adminId: string | undefined;
let office: string;

function recordList(page: Page) {
  return page.locator("section.card").filter({
    has: page.getByRole("form", { name: "Filter drive costs by date" }),
  });
}

async function expectSavedTrip(isRoundTrip: boolean, totalCost: string) {
  const record = await db.driveCost.findFirstOrThrow({
    where: { createdById: adminId, destinationFrom: office },
  });
  expect(record.isRoundTrip).toBe(isRoundTrip);
  expect(record.kilometers.toFixed(2)).toBe("10.00");
  expect(record.ratePerKilometer.toFixed(2)).toBe("5.00");
  expect(record.totalCost.toFixed(2)).toBe(totalCost);
}

async function expectCalculatorTotals(
  page: Page,
  kilometers: number,
  totalCost: string,
  tripType: string,
) {
  const calculator = page.locator("section.calc-card");
  await calculator.getByLabel("Date", { exact: true }).fill(tripDate);
  await calculator
    .getByRole("button", { name: "Calculate", exact: true })
    .click();
  const total = calculator.locator(".calc-total");
  await expect(total).toContainText(`৳${totalCost}`);
  await expect(total).toContainText(`1 trip · ${kilometers} km`);
  const inTime = calculator.locator(".calc-summary-card").filter({
    has: page.getByText("In time", { exact: true }),
  });
  await expect(inTime).toContainText(`৳${totalCost}`);
  await expect(inTime).toContainText(`1 trip · ${kilometers} km`);
  await expect(calculator.locator("tbody tr")).toHaveCount(1);
  await expect(
    calculator.getByRole("cell", { name: tripType, exact: true }),
  ).toBeVisible();
  await expect(
    calculator.getByRole("cell", { name: String(kilometers), exact: true }),
  ).toBeVisible();
}

test.beforeEach(async ({ context }) => {
  const suffix = randomUUID();
  office = `Round trip office ${suffix}`;
  const admin = await db.user.create({
    data: {
      email: `drive-cost-round-trip-${suffix}@example.test`,
      name: "Round Trip Admin",
      role: "ADMIN",
      googleAccountId: suffix,
      accounts: {
        create: { type: "oidc", provider: "google", providerAccountId: suffix },
      },
    },
  });
  adminId = admin.id;
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
});

test.afterEach(async () => {
  if (!adminId) return;
  await db.driveCost.deleteMany({ where: { createdById: adminId } });
  await db.session.deleteMany({ where: { userId: adminId } });
  // Audit history is immutable, so retain it and its referenced user/account.
  // The test database is disposable; all active trip and session fixtures are removed.
  adminId = undefined;
});

test.afterAll(async () => {
  await db.$disconnect();
});

test("only super admins can change payment status, and trip edits preserve it", async ({
  page,
}) => {
  await db.employee.create({
    data: {
      user: { connect: { id: adminId! } },
      employeeCode: randomUUID(),
      office: {
        create: {
          name: office,
          address: "Test office",
          latitude: 23.8,
          longitude: 90.4,
        },
      },
    },
  });
  const trip = await db.driveCost.create({
    data: {
      date: new Date(`${tripDate}T00:00:00Z`),
      destinationFrom: office,
      destinationTo: "Client destination",
      kilometers: 10,
      rateType: "IN_TIME",
      ratePerKilometer: 5,
      totalCost: 50,
      createdById: adminId!,
    },
  });
  expect(trip.paymentStatus).toBe("UNPAID");

  const openList = async (path: string) => {
    await page.goto(path);
    await page
      .getByRole("searchbox", { name: "Search drive costs" })
      .fill(office);
    await expect(recordList(page).locator("tbody tr")).toHaveCount(1);
  };
  const statusButton = (status: "paid" | "unpaid") =>
    recordList(page).getByRole("button", {
      name: `Mark ${status} for drive cost from ${office} to Client destination`,
      exact: true,
    });

  for (const role of ["ADMIN", "MANAGE_DRIVER"] as const) {
    await db.user.update({ where: { id: adminId }, data: { role } });
    await openList(
      role === "ADMIN" ? "/admin/drive-cost" : "/employee/drive-cost",
    );
    await expect(statusButton("paid")).toHaveCount(0);
    const response = await page.request.patch(
      `/api/admin/drive-costs/${trip.id}/payment-status`,
      {
        data: { paymentStatus: "PAID" },
        headers: { Origin: "http://localhost:3100" },
      },
    );
    expect(response.status()).toBe(403);
  }

  await db.user.update({
    where: { id: adminId },
    data: { role: "SUPER_ADMIN" },
  });
  await openList("/admin/drive-cost");
  const request = page.waitForRequest(
    (req) =>
      req.method() === "PATCH" &&
      req.url().endsWith(`${trip.id}/payment-status`),
  );
  await statusButton("paid").click();
  expect((await request).postDataJSON()).toEqual({ paymentStatus: "PAID" });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(statusButton("unpaid")).toBeVisible();
  await expect(
    recordList(page).getByRole("cell", { name: "paid", exact: true }),
  ).toBeVisible();
  const paid = await db.driveCost.findUniqueOrThrow({ where: { id: trip.id } });
  expect(paid.paymentStatus).toBe("PAID");
  expect(paid.kilometers.toFixed(2)).toBe("10.00");
  expect(paid.totalCost.toFixed(2)).toBe("50.00");

  await db.user.update({ where: { id: adminId }, data: { role: "ADMIN" } });
  await openList("/admin/drive-cost");
  await expect(statusButton("unpaid")).toHaveCount(0);
  await recordList(page)
    .getByRole("button", {
      name: `Edit drive cost from ${office} to Client destination`,
      exact: true,
    })
    .click();
  const edit = page.getByRole("dialog", { name: "Edit drive cost" });
  await expect(edit.getByLabel("Payment status", { exact: true })).toHaveCount(
    0,
  );
  await edit.getByLabel("Kilometers (one way) *", { exact: true }).fill("12");
  await edit.getByRole("button", { name: "Save drive cost" }).click();
  await expect(edit).toBeHidden();
  const updated = await db.driveCost.findUniqueOrThrow({
    where: { id: trip.id },
  });
  expect(updated.paymentStatus).toBe("PAID");
  expect(updated.kilometers.toFixed(2)).toBe("12.00");

  await db.user.update({
    where: { id: adminId },
    data: { role: "SUPER_ADMIN" },
  });
  await openList("/admin/drive-cost");
  await statusButton("unpaid").click();
  await expect(statusButton("paid")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    recordList(page).getByRole("cell", { name: "unpaid", exact: true }),
  ).toBeVisible();
});

test("round trips double distance and cost once, survive editing, and can return to one way", async ({
  page,
}) => {
  await page.goto("/admin/drive-cost");
  await page
    .getByRole("button", { name: "Add drive cost", exact: true })
    .click();
  const create = page.getByRole("dialog", { name: "Add drive cost" });
  await create.getByLabel("Date *", { exact: true }).fill(tripDate);
  await create.getByLabel("Destination from *", { exact: true }).fill(office);
  await create
    .getByLabel("Destination to *", { exact: true })
    .fill("Client destination");
  await create.getByLabel("Kilometers (one way) *", { exact: true }).fill("10");
  await expect(create.getByLabel("Trip type", { exact: true })).toHaveValue(
    "one-way",
  );
  const preview = create.locator(".drive-cost-preview");
  await expect(preview).toContainText("৳50.00");
  await create
    .getByLabel("Trip type", { exact: true })
    .selectOption("round-trip");
  await expect(preview).toContainText("10 km × ৳5/km × 2");
  await expect(preview).toContainText("৳100.00");
  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  const tripType = create.getByLabel("Trip type", { exact: true });
  await tripType.scrollIntoViewIfNeeded();
  await expect(tripType).toBeVisible();
  await expect(tripType).toBeInViewport();
  const tripTypeBox = await tripType.boundingBox();
  expect(tripTypeBox).not.toBeNull();
  expect(tripTypeBox!.x).toBeGreaterThanOrEqual(0);
  expect(tripTypeBox!.x + tripTypeBox!.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/drive-cost-round-trip-form.png",
    fullPage: true,
  });
  if (desktopViewport) await page.setViewportSize(desktopViewport);
  await create.getByRole("button", { name: "Save drive cost" }).click();
  await expect(create).toBeHidden();
  await expectSavedTrip(true, "100.00");

  const list = recordList(page);
  await page
    .getByRole("searchbox", { name: "Search drive costs" })
    .fill(office);
  await expect(list.locator("tbody tr")).toHaveCount(1);
  await expect(
    list.getByRole("cell", { name: "Round trip (×2)", exact: true }),
  ).toBeVisible();
  await expect(
    list.getByRole("cell", { name: "20", exact: true }),
  ).toBeVisible();
  await expect(
    list.getByRole("cell", { name: "৳100.00", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Cost calculator", exact: true })
    .click();
  await expectCalculatorTotals(page, 20, "100.00", "Round trip (×2)");

  const editButton = list.getByRole("button", {
    name: `Edit drive cost from ${office} to Client destination`,
    exact: true,
  });
  await editButton.click();
  const edit = page.getByRole("dialog", { name: "Edit drive cost" });
  await expect(
    edit.getByLabel("Kilometers (one way) *", { exact: true }),
  ).toHaveValue("10");
  await expect(edit.getByLabel("Trip type", { exact: true })).toHaveValue(
    "round-trip",
  );
  await expect(edit.locator(".drive-cost-preview")).toContainText("৳100.00");
  await edit.getByRole("button", { name: "Save drive cost" }).click();
  await expect(edit).toBeHidden();
  await expectSavedTrip(true, "100.00");

  await editButton.click();
  await expect(
    edit.getByLabel("Kilometers (one way) *", { exact: true }),
  ).toHaveValue("10");
  await expect(edit.getByLabel("Trip type", { exact: true })).toHaveValue(
    "round-trip",
  );
  await edit.getByLabel("Trip type", { exact: true }).selectOption("one-way");
  await expect(edit.locator(".drive-cost-preview")).toContainText("৳50.00");
  await expect(edit.locator(".drive-cost-preview p")).toHaveText(
    "10 km × ৳5/km",
  );
  await edit.getByRole("button", { name: "Save drive cost" }).click();
  await expect(edit).toBeHidden();
  await expectSavedTrip(false, "50.00");
  await expect(
    list.getByRole("cell", { name: "One way", exact: true }),
  ).toBeVisible();
  await expect(
    list.getByRole("cell", { name: "10", exact: true }),
  ).toBeVisible();
  await expect(
    list.getByRole("cell", { name: "৳50.00", exact: true }),
  ).toBeVisible();
  await expectCalculatorTotals(page, 10, "50.00", "One way");
});
