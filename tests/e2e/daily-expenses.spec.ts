import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  test,
  expect,
  type BrowserContext,
  type Download,
  type Page,
} from "@playwright/test";
import { PrismaClient, Prisma, type Role } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { DailyExpenseTransactionDTO } from "@/modules/daily-expenses/contracts";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
});
const origin = "http://localhost:3100";
async function signIn(context: BrowserContext, role: Role = "SUPER_ADMIN") {
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
    totalExpenses: string;
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
    () => context.request.get("/api/daily-expenses/report"),
    () =>
      context.request.patch("/api/daily-expenses/transactions/unknown", {
        headers: { origin },
        data: {},
      }),
    () =>
      context.request.delete("/api/daily-expenses/transactions/unknown", {
        headers: { origin },
        data: {},
      }),
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

async function createTransaction(
  context: BrowserContext,
  kind: "balance" | "expenses",
  data: { amount: string; date: string; note: string; categoryId?: string },
) {
  const response = await context.request.post(`/api/daily-expenses/${kind}`, {
    headers: { origin },
    data: { ...data, idempotencyKey: randomUUID() },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).data.transaction as DailyExpenseTransactionDTO;
}

async function readPdf(download: Download, path: string) {
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  await download.saveAs(path);
  const bytes = await readFile(path);
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(bytes) });
  const document = await task.promise;
  try {
    const pages = await Promise.all(
      Array.from({ length: document.numPages }, async (_, index) => {
        const content = await (
          await document.getPage(index + 1)
        ).getTextContent();
        return content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .replace(/\s+/g, " ");
      }),
    );
    return { text: pages.join(" "), pages: document.numPages };
  } finally {
    await task.destroy();
  }
}

function expectedPdfMoney(value: string) {
  return `${Number(value) < 0 ? "-" : ""}BDT ${new Intl.NumberFormat("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(Number(value)))}`;
}

test("admins can view and filter the ledger but have no write or export actions", async ({
  page,
  context,
}) => {
  await signIn(context);
  const initial = await summary(context);
  const marker = `Read-only-${randomUUID()}`;
  const categoryResponse = await context.request.post(
    "/api/daily-expenses/categories",
    { headers: { origin }, data: { name: marker } },
  );
  expect(categoryResponse.status()).toBe(200);
  const categoryId = (await categoryResponse.json()).data.id as string;
  const record = await createTransaction(context, "expenses", {
    amount: "1.00",
    date: initial.today,
    note: marker,
    categoryId,
  });
  const before = await summary(context);
  const auditCount = await db.auditLog.count();
  await signIn(context, "ADMIN");
  await openWorkspace(page);
  await page.getByLabel("Search descriptions and notes").fill(marker);
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(page.getByRole("row").filter({ hasText: marker })).toHaveCount(
    1,
  );
  for (const name of [
    "Add Balance",
    "Add Expense",
    "Categories",
    "Edit",
    "Delete",
    "Download PDF",
  ])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  for (const route of ["summary", "transactions", "categories"]) {
    const response = await context.request.get(`/api/daily-expenses/${route}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("no-store");
  }
  const transaction = {
    amount: "99.00",
    date: initial.today,
    idempotencyKey: randomUUID(),
  };
  const writes = [
    () =>
      context.request.post("/api/daily-expenses/balance", {
        headers: { origin },
        data: transaction,
      }),
    () =>
      context.request.post("/api/daily-expenses/expenses", {
        headers: { origin },
        data: { ...transaction, categoryId },
      }),
    () =>
      context.request.post("/api/daily-expenses/categories", {
        headers: { origin },
        data: { name: `${marker}-blocked` },
      }),
    ...[
      { name: `${marker}-renamed` },
      { archived: true },
      { archived: false },
    ].map(
      (data) => () =>
        context.request.patch(`/api/daily-expenses/categories/${categoryId}`, {
          headers: { origin },
          data,
        }),
    ),
    () =>
      context.request.patch(`/api/daily-expenses/transactions/${record.id}`, {
        headers: { origin },
        data: {
          amount: "99.00",
          date: initial.today,
          categoryId,
          expectedVersion: record.version,
        },
      }),
    () =>
      context.request.delete(`/api/daily-expenses/transactions/${record.id}`, {
        headers: { origin },
        data: { expectedVersion: record.version },
      }),
  ];
  for (const write of writes) {
    const response = await write();
    expect(response.status()).toBe(403);
    expect(response.headers()["cache-control"]).toBe("no-store");
  }
  const response = await context.request.get("/api/daily-expenses/report");
  expect(response.status()).toBe(403);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(await summary(context)).toEqual(before);
  expect(await db.auditLog.count()).toBe(auditCount);
  expect(
    await db.dailyExpenseCategory.findUniqueOrThrow({
      where: { id: categoryId },
    }),
  ).toMatchObject({ name: marker, archived: false });
  expect(
    await db.dailyExpenseTransaction.findUniqueOrThrow({
      where: { id: record.id },
    }),
  ).toMatchObject({ version: record.version, deletedAt: null });
});

test("super admins download all filtered PDF records across history pages with accurate totals", async ({
  page,
  context,
}) => {
  const actor = await signIn(context, "SUPER_ADMIN");
  await db.user.update({
    where: { id: actor.id },
    data: { name: "রহিম PDF Recorder" },
  });
  const initial = await summary(context);
  const marker = `PDF-${randomUUID().slice(0, 8)}`;
  const categoryIds: string[] = [];
  const categoryName = `${marker} অফিস ও যাতায়াত`;
  for (const name of [categoryName, `${marker} Excluded category`]) {
    const response = await context.request.post(
      "/api/daily-expenses/categories",
      { headers: { origin }, data: { name } },
    );
    expect(response.status()).toBe(200);
    categoryIds.push((await response.json()).data.id);
  }
  const categoryId = categoryIds[0];
  for (let day = 1; day <= 30; day++) {
    const recordLabel = `${marker} Record ${String(day).padStart(2, "0")}`;
    const note =
      day === 1
        ? `${recordLabel} বাংলা বাজার খরচ ${"Office supplies, transport and daily purchases verified with receipts. ".repeat(18)}`.slice(
            0,
            960,
          ) + " Long note ends here."
        : `${recordLabel} অফিসের দৈনিক খরচ`;
    await createTransaction(context, "expenses", {
      amount: "1.25",
      date: `2023-05-${String(day).padStart(2, "0")}`,
      note,
      categoryId,
    });
  }
  const deleted = await createTransaction(context, "expenses", {
    amount: "9.99",
    date: "2023-05-15",
    note: `${marker} Deleted record`,
    categoryId,
  });
  const removed = await context.request.delete(
    `/api/daily-expenses/transactions/${deleted.id}`,
    { headers: { origin }, data: { expectedVersion: deleted.version } },
  );
  expect(removed.status()).toBe(200);
  await createTransaction(context, "expenses", {
    amount: "7.00",
    date: "2023-05-15",
    note: "Excluded search record",
    categoryId,
  });
  await createTransaction(context, "expenses", {
    amount: "8.00",
    date: "2023-05-15",
    note: `${marker} Wrong category record`,
    categoryId: categoryIds[1],
  });
  await createTransaction(context, "expenses", {
    amount: "9.00",
    date: "2023-06-01",
    note: `${marker} Outside date record`,
    categoryId,
  });
  await createTransaction(context, "balance", {
    amount: "100.00",
    date: "2023-05-15",
    note: `${marker} Balance record`,
  });
  const after = await summary(context);
  expect(after.currentBalance).toBe(
    new Prisma.Decimal(initial.currentBalance).add("38.50").toFixed(2),
  );
  expect(after.totalBalanceAdded).toBe(
    new Prisma.Decimal(initial.totalBalanceAdded).add("100.00").toFixed(2),
  );
  expect(after.totalExpenses).toBe(
    new Prisma.Decimal(initial.totalExpenses).add("61.50").toFixed(2),
  );

  await openWorkspace(page);
  await page.getByLabel("From date", { exact: true }).fill("2023-05-01");
  await page.getByLabel("To date", { exact: true }).fill("2023-05-30");
  await page
    .getByLabel("Transaction type", { exact: true })
    .selectOption("EXPENSE");
  await page.getByLabel("Category", { exact: true }).selectOption(categoryId);
  await page.getByLabel("Search descriptions and notes").fill(marker);
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(page.locator("tbody tr")).toHaveCount(25);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(5);
  await expect(page).toHaveURL(/page=2/);
  // Unsaved form changes must not replace the filters used by the visible history.
  await page
    .getByLabel("Search descriptions and notes")
    .fill("Unapplied PDF search");
  const downloadEvent = page.waitForEvent("download");
  const responseEvent = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/daily-expenses/report",
  );
  await page.getByRole("button", { name: "Download PDF", exact: true }).click();
  const response = await responseEvent;
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/pdf");
  expect(response.headers()["cache-control"]).toBe("no-store");
  const filters = new URL(response.url()).searchParams;
  expect(Object.fromEntries(filters)).toEqual({
    from: "2023-05-01",
    to: "2023-05-30",
    type: "EXPENSE",
    categoryId,
    search: marker,
  });
  const report = await readPdf(
    await downloadEvent,
    "/tmp/daily-expenses-filtered-report.pdf",
  );
  expect(report.pages).toBeGreaterThan(1);
  expect(report.text).toContain("Daily Expenses report");
  expect(report.text).toContain("Type: Expense");
  expect(report.text).toContain(`Note search: ${marker}`);
  expect(report.text).toContain("PDF Recorder");
  expect(report.text).toContain("Long note ends here.");
  for (let day = 1; day <= 30; day++) {
    expect(report.text).toContain(
      `${marker} Record ${String(day).padStart(2, "0")}`,
    );
  }
  for (const excluded of [
    `${marker} Deleted record`,
    "Excluded search record",
    `${marker} Wrong category record`,
    `${marker} Outside date record`,
    `${marker} Balance record`,
    "Unapplied PDF search",
  ]) {
    expect(report.text).not.toContain(excluded);
  }
  for (const [label, value] of [
    ["All-time current balance", after.currentBalance],
    ["All-time balance added", after.totalBalanceAdded],
    ["All-time expenses", after.totalExpenses],
    ["Filtered balance added", "0.00"],
    ["Filtered expenses", "37.50"],
    ["Filtered net change", "-37.50"],
  ]) {
    expect(report.text).toContain(`${label} ${expectedPdfMoney(value)}`);
  }
  expect(report.text).toContain("Filtered records 30");
});

test("super admins can download an empty filtered PDF with zero filtered totals", async ({
  page,
  context,
}) => {
  await signIn(context, "SUPER_ADMIN");
  const before = await summary(context);
  await openWorkspace(page);
  const search = `PDF-empty-${randomUUID().slice(0, 8)}`;
  await page.getByLabel("Search descriptions and notes").fill(search);
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(
    page.getByText("No matching transactions", { exact: true }),
  ).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PDF", exact: true }).click();
  const report = await readPdf(
    await downloadEvent,
    "/tmp/daily-expenses-empty-report.pdf",
  );
  expect(report.pages).toBe(1);
  expect(report.text).toContain(`Note search: ${search}`);
  expect(report.text).toContain("Filtered records 0");
  for (const label of [
    "Filtered balance added",
    "Filtered expenses",
    "Filtered net change",
  ]) {
    expect(report.text).toContain(`${label} BDT 0.00`);
  }
  expect(report.text).toContain(
    `All-time current balance ${expectedPdfMoney(before.currentBalance)}`,
  );
  expect(await summary(context)).toEqual(before);
});

test("only super admins can confirm deletion, removing rows and reversing each record's balance impact", async ({
  page,
  context,
}) => {
  const creator = await signIn(context, "SUPER_ADMIN");
  const initial = await summary(context);
  const marker = `Delete-${randomUUID()}`;
  const categoryResponse = await context.request.post(
    "/api/daily-expenses/categories",
    {
      headers: { origin },
      data: { name: marker },
    },
  );
  expect(categoryResponse.status()).toBe(200);
  const categoryId = (await categoryResponse.json()).data.id as string;
  const expense = await createTransaction(context, "expenses", {
    amount: "12.00",
    date: initial.today,
    note: `${marker} expense`,
    categoryId,
  });
  const balance = await createTransaction(context, "balance", {
    amount: "40.00",
    date: initial.today,
    note: `${marker} balance`,
  });
  const records = [expense, balance];
  const where = { id: { in: records.map((record) => record.id) } };
  const original = await db.dailyExpenseTransaction.findMany({ where });
  const beforeDelete = await summary(context);
  await signIn(context, "ADMIN");
  await openWorkspace(page);
  await page.getByLabel("Search descriptions and notes").fill(marker);
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(page.getByRole("row").filter({ hasText: marker })).toHaveCount(
    2,
  );
  await expect(
    page.getByRole("button", { name: "Delete", exact: true }),
  ).toHaveCount(0);
  for (const record of records) {
    const denied = await context.request.delete(
      `/api/daily-expenses/transactions/${record.id}`,
      {
        headers: { origin },
        data: { expectedVersion: record.version },
      },
    );
    expect(denied.status()).toBe(403);
  }
  expect(await db.dailyExpenseTransaction.findMany({ where })).toEqual(
    original,
  );
  expect(await summary(context)).toEqual(beforeDelete);

  const actor = await signIn(context, "SUPER_ADMIN");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Delete", exact: true }),
  ).toHaveCount(2);
  for (const record of records) {
    const isExpense = record.type === "EXPENSE";
    const row = page.getByRole("row").filter({ hasText: record.note! });
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: isExpense ? "Delete Expense" : "Delete Balance",
      exact: true,
    });
    await expect(dialog).toContainText(
      isExpense
        ? "increase Current Balance"
        : "reduce Current Balance and Total Balance Added",
    );
    await expect(dialog).toContainText(record.note!);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toBeVisible();
    expect(
      (
        await db.dailyExpenseTransaction.findUniqueOrThrow({
          where: { id: record.id },
        })
      ).version,
    ).toBe(record.version);
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Delete record", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(row).toHaveCount(0);
    const after = await summary(context);
    expect(after.currentBalance).toBe(
      new Prisma.Decimal(initial.currentBalance)
        .add(isExpense ? "40.00" : "0.00")
        .toFixed(2),
    );
    expect(after.totalBalanceAdded).toBe(
      new Prisma.Decimal(initial.totalBalanceAdded)
        .add(isExpense ? "40.00" : "0.00")
        .toFixed(2),
    );
    expect(after.totalExpenses).toBe(initial.totalExpenses);
    const cards = page.getByRole("region", {
      name: "All-time ledger balances",
    });
    for (const [label, value] of [
      ["Current Balance", after.currentBalance],
      ["Total Balance Added", after.totalBalanceAdded],
    ]) {
      await expect(
        cards
          .locator(".stat-card")
          .filter({ hasText: label })
          .locator(".stat-value"),
      ).toHaveText(
        `BDT ${new Intl.NumberFormat("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value))}`,
      );
    }
    const audits = await db.auditLog.findMany({
      where: {
        resourceId: record.id,
        action: "DAILY_EXPENSE_TRANSACTION_DELETED",
      },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBe(actor.id);
    expect(audits[0].previousState).toMatchObject({
      amount: record.amount,
      note: record.note,
      createdBy: { id: creator.id },
    });
    expect(audits[0].newState).toMatchObject({
      amount: record.amount,
      note: record.note,
      createdBy: { id: creator.id },
      version: record.version + 1,
      deletedAt: expect.any(String),
    });
    const retained = await db.dailyExpenseTransaction.findUniqueOrThrow({
      where: { id: record.id },
    });
    expect(retained.createdById).toBe(creator.id);
    expect(retained.version).toBe(record.version + 1);
    expect(retained.deletedAt).toBeInstanceOf(Date);
  }
  await expect(
    page.getByText("No matching transactions", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`search=${marker}`));
  const history = await context.request.get(
    `/api/daily-expenses/transactions?search=${marker}`,
  );
  expect(history.status()).toBe(200);
  expect((await history.json()).data).toMatchObject({ items: [], total: 0 });
});

test("a lost deletion response safely retries one confirmed removal without changing balances twice", async ({
  page,
  context,
}) => {
  await signIn(context, "SUPER_ADMIN");
  const initial = await summary(context);
  const note = `Delete-retry-${randomUUID()}`;
  const record = await createTransaction(context, "balance", {
    amount: "3.00",
    date: initial.today,
    note,
  });
  await openWorkspace(page);
  const submissions: Array<{ expectedVersion: number }> = [];
  await page.route(
    `**/api/daily-expenses/transactions/${record.id}`,
    async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      submissions.push(route.request().postDataJSON());
      if (submissions.length === 1) {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await route.abort("failed");
      } else await route.continue();
    },
  );
  const row = page.getByRole("row").filter({ hasText: note });
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Delete Balance",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Delete record", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Safe retry", exact: true }),
  ).toBeVisible();
  expect(await summary(context)).toEqual(initial);
  await dialog.getByRole("button", { name: "Safe retry", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toHaveCount(0);
  expect(submissions).toEqual([
    { expectedVersion: record.version },
    { expectedVersion: record.version },
  ]);
  expect(await summary(context)).toEqual(initial);
  expect(
    await db.auditLog.count({
      where: {
        resourceId: record.id,
        action: "DAILY_EXPENSE_TRANSACTION_DELETED",
      },
    }),
  ).toBe(1);
});

test("stale deletion preserves a newer edit until the latest record is reviewed", async ({
  page,
  context,
}) => {
  await signIn(context, "SUPER_ADMIN");
  const initial = await summary(context);
  const note = `Delete-stale-${randomUUID()}`;
  const record = await createTransaction(context, "balance", {
    amount: "10.00",
    date: initial.today,
    note,
  });
  await openWorkspace(page);
  const row = page.getByRole("row").filter({ hasText: note });
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Delete Balance",
    exact: true,
  });
  const winner = await context.request.patch(
    `/api/daily-expenses/transactions/${record.id}`,
    {
      headers: { origin },
      data: {
        amount: "25.00",
        date: record.date,
        note,
        expectedVersion: record.version,
      },
    },
  );
  expect(winner.status()).toBe(200);
  await dialog
    .getByRole("button", { name: "Delete record", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Close and refresh", exact: true }),
  ).toBeVisible();
  expect(
    await db.auditLog.count({
      where: {
        resourceId: record.id,
        action: "DAILY_EXPENSE_TRANSACTION_DELETED",
      },
    }),
  ).toBe(0);
  expect((await summary(context)).currentBalance).toBe(
    new Prisma.Decimal(initial.currentBalance).add("25.00").toFixed(2),
  );
  await dialog
    .getByRole("button", { name: "Close and refresh", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    row.getByRole("cell", { name: "+BDT 25.00", exact: true }),
  ).toBeVisible();
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toContainText("BDT 25.00");
  await dialog
    .getByRole("button", { name: "Delete record", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(row).toHaveCount(0);
  expect(await summary(context)).toEqual(initial);
  expect(
    await db.auditLog.count({
      where: {
        resourceId: record.id,
        action: "DAILY_EXPENSE_TRANSACTION_DELETED",
      },
    }),
  ).toBe(1);
});

test("only super admins can edit records, preserving their creator and refreshing audited totals", async ({
  page,
  context,
}) => {
  const creator = await signIn(context, "SUPER_ADMIN");
  const initial = await summary(context);
  const marker = `Edit-${randomUUID()}`;
  const categoryIds: string[] = [];
  for (const suffix of ["original", "corrected"]) {
    const response = await context.request.post(
      "/api/daily-expenses/categories",
      {
        headers: { origin },
        data: { name: `${marker} ${suffix}` },
      },
    );
    expect(response.status()).toBe(200);
    categoryIds.push((await response.json()).data.id);
  }
  const records: DailyExpenseTransactionDTO[] = [];
  for (const kind of ["balance", "expenses"] as const) {
    const response = await context.request.post(`/api/daily-expenses/${kind}`, {
      headers: { origin },
      data: {
        amount: kind === "balance" ? "20.00" : "5.00",
        date: initial.today,
        note: `${marker} ${kind}`,
        idempotencyKey: randomUUID(),
        ...(kind === "expenses" ? { categoryId: categoryIds[0] } : {}),
      },
    });
    expect(response.status()).toBe(200);
    records.push((await response.json()).data.transaction);
  }
  const where = { id: { in: records.map((record) => record.id) } };
  const original = await db.dailyExpenseTransaction.findMany({ where });
  const auditCount = await db.auditLog.count({
    where: { resourceId: { in: records.map((record) => record.id) } },
  });
  await signIn(context, "ADMIN");
  await openWorkspace(page);
  await page.getByLabel("Search descriptions and notes").fill(marker);
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(page.getByRole("row").filter({ hasText: marker })).toHaveCount(
    2,
  );
  await expect(
    page.getByRole("button", { name: "Edit", exact: true }),
  ).toHaveCount(0);
  for (const record of records) {
    const denied = await context.request.patch(
      `/api/daily-expenses/transactions/${record.id}`,
      {
        headers: { origin },
        data: {
          amount: "99.00",
          date: initial.today,
          note: "Unauthorized correction",
          expectedVersion: record.version,
          ...(record.category ? { categoryId: record.category.id } : {}),
        },
      },
    );
    expect(denied.status()).toBe(403);
  }
  expect(await db.dailyExpenseTransaction.findMany({ where })).toEqual(
    original,
  );
  expect(
    await db.auditLog.count({
      where: { resourceId: { in: records.map((record) => record.id) } },
    }),
  ).toBe(auditCount);

  const editor = await signIn(context, "SUPER_ADMIN");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Edit", exact: true }),
  ).toHaveCount(2);
  await page.evaluate(() => {
    (window as Window & { dailyDocumentMarker?: string }).dailyDocumentMarker =
      "edit-without-reload";
  });
  for (const record of records) {
    const expense = record.type === "EXPENSE";
    const amount = expense ? "8.00" : "30.00";
    const correctedNote = `${record.note} corrected`;
    await page
      .getByRole("row")
      .filter({ hasText: record.note! })
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: expense ? "Edit Expense" : "Edit Balance",
      exact: true,
    });
    await expect(dialog.getByLabel("Amount (BDT)")).toHaveValue(record.amount);
    await expect(
      dialog.getByLabel("Transaction date", { exact: true }),
    ).toHaveValue(record.date);
    await dialog.getByLabel("Amount (BDT)").fill(amount);
    await dialog
      .getByLabel("Transaction date", { exact: true })
      .fill("2001-02-03");
    if (expense) {
      await dialog
        .getByLabel("Category", { exact: true })
        .selectOption(categoryIds[1]);
    }
    await dialog
      .getByLabel(
        expense
          ? "Description / note (optional)"
          : "Note / source description (optional)",
      )
      .fill(correctedNote);
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    const row = page.getByRole("row").filter({ hasText: correctedNote });
    await expect(row).toHaveCount(1);
    await expect(
      row.getByRole("cell", {
        name: `${expense ? "−" : "+"}BDT ${amount}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(row.locator("time")).toHaveAttribute("datetime", "2001-02-03");
    await expect(
      row.getByRole("cell", { name: creator.name!, exact: true }),
    ).toBeVisible();
    if (expense) {
      await expect(
        row.getByRole("cell", { name: `${marker} corrected`, exact: true }),
      ).toBeVisible();
    }
    const stored = await db.dailyExpenseTransaction.findUniqueOrThrow({
      where: { id: record.id },
    });
    expect(stored.createdById).toBe(creator.id);
    expect(stored.createdAt.toISOString()).toBe(record.createdAt);
    expect(stored.version).toBe(record.version + 1);
    const audits = await db.auditLog.findMany({
      where: {
        resourceId: record.id,
        action: "DAILY_EXPENSE_TRANSACTION_UPDATED",
      },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBe(editor.id);
    expect(audits[0].previousState).toMatchObject({
      amount: record.amount,
      date: record.date,
      note: record.note,
      createdBy: { id: creator.id },
    });
    expect(audits[0].newState).toMatchObject({
      amount,
      date: "2001-02-03",
      note: correctedNote,
      createdBy: { id: creator.id },
    });
  }
  const after = await summary(context);
  expect(after.currentBalance).toBe(
    new Prisma.Decimal(initial.currentBalance).add("22.00").toFixed(2),
  );
  expect(after.totalBalanceAdded).toBe(
    new Prisma.Decimal(initial.totalBalanceAdded).add("30.00").toFixed(2),
  );
  expect(after.totalExpenses).toBe(
    new Prisma.Decimal(initial.totalExpenses).add("8.00").toFixed(2),
  );
  const cards = page.getByRole("region", { name: "All-time ledger balances" });
  for (const [label, value] of [
    ["Current Balance", after.currentBalance],
    ["Total Balance Added", after.totalBalanceAdded],
  ]) {
    await expect(
      cards
        .locator(".stat-card")
        .filter({ hasText: label })
        .locator(".stat-value"),
    ).toHaveText(
      `BDT ${new Intl.NumberFormat("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value))}`,
    );
  }
  await expect(page).toHaveURL(new RegExp(`search=${marker}`));
  expect(
    await page.evaluate(
      () =>
        (window as Window & { dailyDocumentMarker?: string })
          .dailyDocumentMarker,
    ),
  ).toBe("edit-without-reload");
});

test("stale edits cannot overwrite a newer correction and refresh before reopening", async ({
  page,
  context,
}) => {
  const editor = await signIn(context, "SUPER_ADMIN");
  const initial = await summary(context);
  const note = `Stale-edit-${randomUUID()}`;
  const created = await context.request.post("/api/daily-expenses/balance", {
    headers: { origin },
    data: {
      amount: "10.00",
      date: initial.today,
      note,
      idempotencyKey: randomUUID(),
    },
  });
  expect(created.status()).toBe(200);
  const record = (await created.json()).data
    .transaction as DailyExpenseTransactionDTO;
  await openWorkspace(page);
  await page
    .getByRole("row")
    .filter({ hasText: note })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Edit Balance",
    exact: true,
  });
  await dialog.getByLabel("Amount (BDT)").fill("40.00");
  const winner = await context.request.patch(
    `/api/daily-expenses/transactions/${record.id}`,
    {
      headers: { origin },
      data: {
        amount: "25.00",
        date: record.date,
        note,
        expectedVersion: record.version,
      },
    },
  );
  expect(winner.status()).toBe(200);
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "This transaction has changed since you opened it.",
  );
  await expect(dialog.getByLabel("Amount (BDT)")).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Close and refresh", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole("row").filter({ hasText: note });
  await expect(
    row.getByRole("cell", { name: "+BDT 25.00", exact: true }),
  ).toBeVisible();
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(dialog.getByLabel("Amount (BDT)")).toHaveValue("25.00");
  await expect(dialog.getByLabel("Amount (BDT)")).toBeEnabled();
  await dialog.getByLabel("Amount (BDT)").fill("30.00");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    row.getByRole("cell", { name: "+BDT 30.00", exact: true }),
  ).toBeVisible();
  const stored = await db.dailyExpenseTransaction.findUniqueOrThrow({
    where: { id: record.id },
  });
  expect(stored.amount.toFixed(2)).toBe("30.00");
  expect(stored.version).toBe(record.version + 2);
  expect(
    await db.auditLog.count({
      where: {
        resourceId: record.id,
        actorId: editor.id,
        action: "DAILY_EXPENSE_TRANSACTION_UPDATED",
      },
    }),
  ).toBe(2);
});

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
