import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { PrismaClient, Prisma, type Role } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
});
const origin = "http://localhost:3100";
async function signIn(context: BrowserContext, role: Role = "ADMIN") {
  const marker = randomUUID();
  const user = await db.user.create({
    data: {
      name: "Daily Expenses Tester",
      email: `daily-${marker}@example.test`,
      role,
      googleAccountId: marker,
    },
  });
  const token = randomUUID();
  await db.session.create({
    data: {
      userId: user.id,
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
  return user;
}
async function summary(context: BrowserContext) {
  const response = await context.request.get("/api/daily-expenses/summary");
  expect(response.status()).toBe(200);
  return (await response.json()).data as {
    currentBalance: string;
    totalBalanceAdded: string;
    today: string;
  };
}
async function openWorkspace(page: Page) {
  await page.goto("/daily-expenses");
  await expect(
    page.getByRole("heading", { name: "Daily Expenses", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Current Balance", { exact: true }),
  ).toBeVisible();
}

test.afterAll(async () => db.$disconnect());

test("page and every API reject unauthenticated, employee, and driver-manager access", async ({
  page,
  context,
}) => {
  const calls = [
    () => context.request.get("/api/daily-expenses/summary"),
    () => context.request.get("/api/daily-expenses/transactions"),
    () => context.request.get("/api/daily-expenses/categories"),
    () =>
      context.request.post("/api/daily-expenses/balance", {
        headers: { origin },
        data: {},
      }),
    () =>
      context.request.post("/api/daily-expenses/expenses", {
        headers: { origin },
        data: {},
      }),
    () =>
      context.request.post("/api/daily-expenses/categories", {
        headers: { origin },
        data: {},
      }),
    () =>
      context.request.patch("/api/daily-expenses/categories/unknown", {
        headers: { origin },
        data: {},
      }),
  ];
  for (const call of calls) expect((await call()).status()).toBe(401);
  await page.goto("/daily-expenses");
  await expect(page).toHaveURL(/\/login/);
  for (const role of ["EMPLOYEE", "MANAGE_DRIVER"] as const) {
    await signIn(context, role);
    for (const call of calls) expect((await call()).status()).toBe(403);
    await page.goto("/daily-expenses");
    await expect(page).toHaveURL(/\/forbidden/);
  }
});

test("authorized users without Employee profiles have isolated, no-store, idempotent APIs", async ({
  context,
}) => {
  const actor = await signIn(context, "SUPER_ADMIN");
  expect(
    await db.employee.findUnique({ where: { userId: actor.id } }),
  ).toBeNull();
  const unrelated = async () =>
    Promise.all([
      db.attendance.count(),
      db.driveCost.count(),
      db.leave.count(),
      db.attendanceEvent.count(),
    ]);
  const unchanged = await unrelated();
  const before = await summary(context);
  const payload = {
    amount: "0.10",
    date: before.today,
    note: `API ${randomUUID()}`,
    idempotencyKey: randomUUID(),
  };
  const crossSite = await context.request.post("/api/daily-expenses/balance", {
    headers: { origin: "https://untrusted.example.test" },
    data: payload,
  });
  expect(crossSite.status()).toBe(403);
  const responses = await Promise.all(
    [1, 2, 3].map(() =>
      context.request.post("/api/daily-expenses/balance", {
        headers: { origin },
        data: payload,
      }),
    ),
  );
  const ids = [];
  for (const response of responses) {
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("no-store");
    ids.push((await response.json()).data.transaction.id);
  }
  expect(new Set(ids).size).toBe(1);
  expect((await summary(context)).currentBalance).toBe(
    new Prisma.Decimal(before.currentBalance).add("0.10").toFixed(2),
  );
  const conflict = await context.request.post("/api/daily-expenses/balance", {
    headers: { origin },
    data: { ...payload, amount: "0.20" },
  });
  expect(conflict.status()).toBe(409);
  const invalid = await context.request.get(
    "/api/daily-expenses/transactions?pageSize=101",
  );
  expect(invalid.status()).toBe(400);
  for (const method of ["PATCH", "DELETE"]) {
    expect(
      (
        await context.request.fetch(`/api/daily-expenses/balance`, {
          method,
          headers: { origin },
          data: payload,
        })
      ).status(),
    ).toBe(405);
  }
  expect(await unrelated()).toEqual(unchanged);
});

async function saveBalance(page: Page, amount: string, note: string) {
  await page.getByRole("button", { name: "Add Balance", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add Balance", exact: true });
  await dialog.getByLabel("Amount (BDT)").fill(amount);
  await dialog.getByLabel("Note / source description (optional)").fill(note);
  await dialog.getByRole("button", { name: "Save balance addition" }).click();
  return dialog;
}

test("ledger UI saves without reload, preserves filters, manages archived categories, and works on mobile", async ({
  page,
  context,
}) => {
  await signIn(context);
  const initial = await summary(context);
  await openWorkspace(page);
  await expect(
    page.getByRole("link", { name: "Daily Expenses", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  const cards = page
    .getByRole("region", { name: "All-time ledger balances" })
    .locator(".stat-card");
  await expect(cards).toHaveCount(2);
  const desktop = await cards.evaluateAll((elements) =>
    elements.map((element) => ({
      x: element.getBoundingClientRect().x,
      y: element.getBoundingClientRect().y,
    })),
  );
  expect(desktop[0].y).toBe(desktop[1].y);
  expect(desktop[0].x).toBeLessThan(desktop[1].x);

  const marker = `UI-${randomUUID()}`;
  await page.getByRole("button", { name: "Categories", exact: true }).click();
  const categories = page.getByRole("dialog", {
    name: "Categories",
    exact: true,
  });
  await categories.getByLabel("New category").fill(marker);
  await categories
    .getByRole("button", { name: "Create category", exact: true })
    .click();
  await expect(categories.getByRole("status")).toContainText(
    "Category created.",
  );
  await categories.getByRole("button", { name: "Done", exact: true }).click();

  await page.getByLabel("Search descriptions and notes").fill(marker);
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`search=${marker}`));
  await expect(
    page.getByText("No matching transactions", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as Window & { dailyDocumentMarker?: string }).dailyDocumentMarker =
      "same-document";
  });
  await expect(
    await saveBalance(page, "10.00", "Hidden by current search"),
  ).toBeHidden();
  await expect(
    page.getByRole("status").filter({ hasText: "Balance addition saved" }),
  ).toBeVisible();
  await expect(
    page.getByText("No matching transactions", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as Window & { dailyDocumentMarker?: string })
          .dailyDocumentMarker,
    ),
  ).toBe("same-document");

  await page.getByRole("button", { name: "Add Expense", exact: true }).click();
  const expense = page.getByRole("dialog", {
    name: "Add Expense",
    exact: true,
  });
  await expect(
    expense.getByLabel("Transaction date", { exact: true }),
  ).toHaveValue(initial.today);
  await expense.getByLabel("Amount (BDT)").fill("15.00");
  await expense
    .getByLabel("Category", { exact: true })
    .selectOption({ label: marker });
  await expense.getByLabel("Description / note (optional)").fill(marker);
  await expense
    .getByRole("button", { name: "Save expense", exact: true })
    .click();
  await expect(expense).toBeHidden();
  await expect(page.getByRole("row").filter({ hasText: marker })).toHaveCount(
    1,
  );
  await expect(
    page.getByRole("cell", { name: "−BDT 15.00", exact: true }),
  ).toBeVisible();
  const after = await summary(context);
  expect(after.currentBalance).toBe(
    new Prisma.Decimal(initial.currentBalance).sub("5.00").toFixed(2),
  );
  expect(after.totalBalanceAdded).toBe(
    new Prisma.Decimal(initial.totalBalanceAdded).add("10.00").toFixed(2),
  );
  const balances = await cards.allTextContents();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`from=${initial.today}`));
  expect(await cards.allTextContents()).toEqual(balances);

  await page.getByRole("button", { name: "Categories", exact: true }).click();
  await categories
    .getByRole("button", { name: `Archive ${marker}`, exact: true })
    .click();
  await expect(categories.getByRole("status")).toContainText(
    "Category archived.",
  );
  await categories.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: `${marker} (archived)`, exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("#daily-category-filter option").filter({ hasText: marker }),
  ).toHaveText(`${marker} (archived)`);
  await page.getByRole("button", { name: "Add Expense", exact: true }).click();
  await expect(
    expense.locator("select option").filter({ hasText: marker }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(expense).toBeHidden();

  await page.screenshot({
    path: "/tmp/daily-expenses-desktop.png",
    animations: "disabled",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await cards.evaluateAll((elements) =>
    elements.map((element) => ({
      x: element.getBoundingClientRect().x,
      y: element.getBoundingClientRect().y,
    })),
  );
  expect(mobile[0].x).toBe(mobile[1].x);
  expect(mobile[0].y).toBeLessThan(mobile[1].y);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/daily-expenses-mobile.png",
    animations: "disabled",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Daily Expenses", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Daily Expenses", exact: true }).click();
  await page.getByRole("button", { name: "Add Balance", exact: true }).click();
  const balanceDialog = page.getByRole("dialog", {
    name: "Add Balance",
    exact: true,
  });
  await expect(
    balanceDialog.getByRole("button", { name: "Close dialog" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    balanceDialog.getByRole("button", { name: "Save balance addition" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    balanceDialog.getByRole("button", { name: "Close dialog" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(balanceDialog).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Add Balance", exact: true }),
  ).toBeFocused();
});

test("a lost mutation response safely retries the same key and frozen values exactly once", async ({
  page,
  context,
}) => {
  await signIn(context);
  await openWorkspace(page);
  const note = `Retry-${randomUUID()}`;
  const submissions: Array<{ idempotencyKey: string; amount: string }> = [];
  let first = true;
  await page.route("**/api/daily-expenses/balance", async (route) => {
    submissions.push(route.request().postDataJSON());
    if (first) {
      first = false;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
    } else await route.continue();
  });
  const dialog = await saveBalance(page, "0.11", note);
  await expect(
    dialog.getByRole("button", { name: "Safe retry", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel("Amount (BDT)")).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Keep pending", exact: true })
    .click();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page).toHaveURL(/\/daily-expenses$/);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Safe retry", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "earlier submission was already recorded" }),
  ).toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[0]).toEqual(submissions[1]);
  expect(await db.dailyExpenseTransaction.count({ where: { note } })).toBe(1);
});

test("a confirmed save followed by failed refresh does not invite another write", async ({
  page,
  context,
}) => {
  await signIn(context);
  await openWorkspace(page);
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeEnabled();
  await page.route("**/api/daily-expenses/summary", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        success: false,
        error: { message: "Test refresh failure" },
      }),
    }),
  );
  const note = `Confirmed-${randomUUID()}`;
  await expect(await saveBalance(page, "0.12", note)).toBeHidden();
  await expect(
    page.getByRole("alert").filter({ hasText: "Your transaction was saved" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Safe retry", exact: true }),
  ).toHaveCount(0);
  expect(await db.dailyExpenseTransaction.count({ where: { note } })).toBe(1);
  await page.unroute("**/api/daily-expenses/summary");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Your transaction was saved" }),
  ).toBeHidden();
});

test("initial summary failure shows unavailable cards instead of fake zero balances", async ({
  page,
  context,
}) => {
  await signIn(context);
  await page.route("**/api/daily-expenses/summary", (route) =>
    route.abort("failed"),
  );
  await openWorkspace(page);
  const cards = page.getByRole("region", { name: "All-time ledger balances" });
  await expect(cards.getByText("Unavailable", { exact: true })).toHaveCount(2);
  await expect(cards).not.toContainText("BDT 0.00");
  await expect(
    page.getByRole("button", { name: "Add Balance", exact: true }),
  ).toBeDisabled();
});

test("category rename and restore remain usable while invalid money keeps the entered form without a write", async ({
  page,
  context,
}) => {
  await signIn(context);
  await openWorkspace(page);
  const name = `Controls-${randomUUID()}`;
  const renamed = `${name}-renamed`;
  await page.getByRole("button", { name: "Categories", exact: true }).click();
  const categories = page.getByRole("dialog", {
    name: "Categories",
    exact: true,
  });
  await categories.getByLabel("New category").fill(name);
  await categories
    .getByRole("button", { name: "Create category", exact: true })
    .click();
  await categories
    .getByRole("button", { name: `Rename ${name}`, exact: true })
    .click();
  await categories.getByLabel("Rename category", { exact: true }).fill(renamed);
  await categories
    .getByRole("button", { name: "Save name", exact: true })
    .click();
  await expect(categories.getByRole("status")).toContainText(
    "Category renamed.",
  );
  await categories
    .getByRole("button", { name: `Archive ${renamed}`, exact: true })
    .click();
  await expect(categories.getByRole("status")).toContainText(
    "Category archived.",
  );
  await categories
    .getByRole("button", { name: `Restore ${renamed}`, exact: true })
    .click();
  await expect(categories.getByRole("status")).toContainText(
    "Category restored.",
  );
  await expect(
    categories.getByRole("button", { name: `Archive ${renamed}`, exact: true }),
  ).toBeVisible();
  await expect(
    categories.getByRole("button", { name: `Restore ${renamed}`, exact: true }),
  ).toHaveCount(0);
  await categories.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.locator("#daily-category-filter option").filter({ hasText: renamed }),
  ).toHaveText(renamed);

  let balanceWrites = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/daily-expenses/balance"
    )
      balanceWrites += 1;
  });
  // Twenty characters must reach validation; truncating the third fractional
  // digit would silently turn this invalid amount into a valid maximum amount.
  const amount = "9999999999999999.999";
  const dialog = await saveBalance(page, amount, name);
  await expect(dialog.getByRole("alert")).toContainText(
    "Check the highlighted fields",
  );
  await expect(dialog.getByLabel("Amount (BDT)")).toHaveValue(amount);
  await expect(dialog.getByLabel("Amount (BDT)")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(
    dialog.getByLabel("Note / source description (optional)"),
  ).toHaveValue(name);
  await expect(
    dialog.getByRole("button", { name: "Save balance addition" }),
  ).toBeEnabled();
  expect(balanceWrites).toBe(0);
  expect(
    await db.dailyExpenseTransaction.count({ where: { note: name } }),
  ).toBe(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("an uncommitted archived-category retry permits correction while a rate-limited retry retains the committed key", async ({
  page,
  context,
  browser,
}) => {
  await signIn(context);
  const name = `Retry-category-${randomUUID()}`;
  const created = await context.request.post("/api/daily-expenses/categories", {
    headers: { origin },
    data: { name },
  });
  expect(created.status()).toBe(200);
  const category = (await created.json()).data as { id: string };
  const otherAdmin = await browser.newContext({ baseURL: origin });
  await signIn(otherAdmin);
  try {
    await openWorkspace(page);
    const note = `Correction-${randomUUID()}`;
    const submissions: Array<{ idempotencyKey: string; amount: string }> = [];
    await page.route("**/api/daily-expenses/expenses", async (route) => {
      submissions.push(route.request().postDataJSON());
      if (submissions.length === 1) {
        // No request reaches the server, but the browser cannot know that.
        await route.abort("failed");
      } else if (submissions.length === 3) {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await route.abort("failed");
      } else if (submissions.length === 4) {
        await route.fulfill({
          status: 429,
          contentType: "application/json",
          headers: { "Retry-After": "1" },
          body: JSON.stringify({
            success: false,
            error: { code: "RATE_LIMITED", message: "Please retry shortly." },
          }),
        });
      } else await route.continue();
    });
    await page
      .getByRole("button", { name: "Add Expense", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Add Expense",
      exact: true,
    });
    await dialog.getByLabel("Amount (BDT)").fill("0.13");
    await dialog
      .getByLabel("Category", { exact: true })
      .selectOption({ label: name });
    await dialog.getByLabel("Description / note (optional)").fill(note);
    await dialog
      .getByRole("button", { name: "Save expense", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Safe retry", exact: true }),
    ).toBeVisible();
    await expect(dialog.getByLabel("Amount (BDT)")).toBeDisabled();

    const archive = await otherAdmin.request.patch(
      `/api/daily-expenses/categories/${category.id}`,
      {
        headers: { origin },
        data: { archived: true },
      },
    );
    expect(archive.status()).toBe(200);
    await dialog
      .getByRole("button", { name: "Safe retry", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText("active category");
    await expect(dialog.getByLabel("Amount (BDT)")).toBeEnabled();
    await expect(dialog.getByLabel("Amount (BDT)")).toHaveValue("0.13");
    await expect(
      dialog.getByLabel("Description / note (optional)"),
    ).toHaveValue(note);
    await expect(
      dialog.getByRole("button", { name: "Safe retry", exact: true }),
    ).toHaveCount(0);
    expect(submissions).toHaveLength(2);
    expect(submissions[0]).toEqual(submissions[1]);
    expect(await db.dailyExpenseTransaction.count({ where: { note } })).toBe(0);

    const restore = await otherAdmin.request.patch(
      `/api/daily-expenses/categories/${category.id}`,
      {
        headers: { origin },
        data: { archived: false },
      },
    );
    expect(restore.status()).toBe(200);
    await dialog.getByLabel("Amount (BDT)").fill("0.14");
    await dialog
      .getByRole("button", { name: "Save expense", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Safe retry", exact: true }),
    ).toBeVisible();
    expect(submissions[2].idempotencyKey).not.toBe(
      submissions[0].idempotencyKey,
    );
    await dialog
      .getByRole("button", { name: "Safe retry", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Safe retry", exact: true }),
    ).toBeVisible();
    await expect(dialog.getByLabel("Amount (BDT)")).toBeDisabled();
    await expect(dialog.getByLabel("Amount (BDT)")).toHaveValue("0.14");
    expect(submissions).toHaveLength(4);
    expect(submissions[3]).toEqual(submissions[2]);
    await dialog
      .getByRole("button", { name: "Safe retry", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "earlier submission was already recorded" }),
    ).toBeVisible();
    expect(submissions).toHaveLength(5);
    expect(submissions[4]).toEqual(submissions[2]);
    const transactions = await db.dailyExpenseTransaction.findMany({
      where: { note },
    });
    expect(transactions).toHaveLength(1);
    expect(transactions[0].amount.toFixed(2)).toBe("0.14");
    expect(transactions[0].idempotencyKey).toBe(submissions[2].idempotencyKey);
  } finally {
    await otherAdmin.close();
  }
});
