import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { Prisma, PrismaClient, type Role } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { testSessionCookie } from "./session-cookie";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
});
const origin = "http://localhost:3100";
const endpoint = "/api/admin/company-money";
const fixtureUserIds: string[] = [];
const additionDate = "2026-09-30";
const removalDate = "2026-10-01";

type CompanyMoney = {
  balance: string;
  totalAdded: string;
  totalRemoved: string;
  items: Array<{
    id: string;
    type: "ADD" | "REMOVE";
    date: string;
    amount: string;
    note: string | null;
    version: number;
  }>;
  total: number;
  page: number;
  pageSize: number;
};
type MoneyRecord = CompanyMoney["items"][number];

async function createMoneyRecord(
  context: BrowserContext,
  input: {
    type: "ADD" | "REMOVE";
    date: string;
    amount: string;
    note: string;
  },
) {
  const payload = { requestId: randomUUID(), ...input };
  const response = await context.request.post(endpoint, {
    headers: { origin },
    data: payload,
  });
  expect(response.status()).toBe(200);
  const record = (await response.json()).data as MoneyRecord;
  expect(record.version).toBe(1);
  return { payload, record };
}

async function signIn(context: BrowserContext, role: Role) {
  const marker = randomUUID();
  const user = await db.user.create({
    data: {
      name: `Company Money ${role}`,
      email: `company-money-${marker}@example.test`,
      role,
      googleAccountId: marker,
      // Employee profiles let these roles authenticate before RBAC rejects
      // their access. Administrative users do not need employee profiles.
      ...(role === "EMPLOYEE" || role === "MANAGE_DRIVER"
        ? {
            employee: {
              create: {
                employeeCode: marker,
                office: {
                  create: {
                    name: `Company money access office ${marker}`,
                    address: "Test office",
                    latitude: 23.8,
                    longitude: 90.4,
                  },
                },
              },
            },
          }
        : {}),
    },
  });
  fixtureUserIds.push(user.id);
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
      value: await testSessionCookie(db, token),
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return user;
}

async function readMoney(
  context: BrowserContext,
  page = 1,
): Promise<CompanyMoney> {
  const response = await context.request.get(`${endpoint}?page=${page}`);
  expect(response.status()).toBe(200);
  const data = (await response.json()).data as CompanyMoney;
  for (const amount of [data.balance, data.totalAdded, data.totalRemoved]) {
    expect(amount).toMatch(/^\d+\.\d{2}$/);
  }
  for (const item of data.items) {
    expect(item.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isInteger(item.version)).toBe(true);
    expect(item.version).toBeGreaterThanOrEqual(1);
  }
  return data;
}

async function findMoneyRecord(context: BrowserContext, id: string) {
  let history = await readMoney(context);
  for (
    let page = 1;
    page <= Math.max(1, Math.ceil(history.total / history.pageSize));
    page++
  ) {
    if (page > 1) history = await readMoney(context, page);
    const item = history.items.find((record) => record.id === id);
    if (item) return { item, page };
  }
  throw new Error(`Company money transaction ${id} was missing from history.`);
}

async function showHistoryPage(page: Page, target: number) {
  const pagination = page.locator(".pagination");
  const indicator = pagination.locator("span").first();
  await expect(indicator).toBeVisible();
  const current = Number(
    (await indicator.innerText()).match(/^Page (\d+)/)?.[1],
  );
  expect(Number.isInteger(current)).toBe(true);
  const step = target > current ? 1 : -1;
  for (let next = current + step; next !== target + step; next += step) {
    await pagination
      .getByRole("button", {
        name: step > 0 ? "Next" : "Previous",
        exact: true,
      })
      .click();
    await expect(indicator).toHaveText(new RegExp(`^Page ${next} ·`));
  }
}

function taka(value: string) {
  return `৳${Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function summaryValue(page: Page, label: string) {
  return page
    .getByRole("region", { name: "Company balance", exact: true })
    .getByText(label, { exact: true })
    .locator("..")
    .locator("strong");
}

async function openCompanyMoney(page: Page) {
  await page.goto("/admin/company-money");
  await expect(
    page.getByRole("heading", { name: "Company money", exact: true }),
  ).toBeVisible();
}

test.afterEach(async () => {
  await db.session.deleteMany({
    where: { userId: { in: fixtureUserIds.splice(0) } },
  });
  // Retain financial records, operation receipts and audit history in the
  // disposable database; assertions use the opening balance for isolation.
});

test.afterAll(async () => db.$disconnect());

test("super admins add and remove money, with persisted balance and transaction history", async ({
  page,
  context,
}) => {
  const actor = await signIn(context, "SUPER_ADMIN");
  const initial = await readMoney(context);
  const marker = randomUUID();
  const additionNote = `Company funding ${marker}`;
  const removalNote = `Company withdrawal ${marker}`;
  await openCompanyMoney(page);
  const form = page.getByRole("form", {
    name: "Update company balance",
    exact: true,
  });
  const currentBalance = summaryValue(page, "Current balance");
  await expect(currentBalance).toHaveText(taka(initial.balance));
  const dateInput = form.getByLabel("Transaction date", { exact: true });
  await expect(dateInput).toHaveAttribute("type", "date");
  await expect(dateInput).toHaveAttribute("required", "");
  await expect(dateInput).toHaveValue(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Dhaka",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()),
  );

  const save = async (
    type: "ADD" | "REMOVE",
    amount: string,
    note: string,
    date: string,
  ) => {
    await form
      .getByLabel("Transaction type", { exact: true })
      .selectOption(type);
    await dateInput.fill(date);
    await form.getByLabel("Amount (BDT)", { exact: true }).fill(amount);
    await form.getByLabel("Note (optional)", { exact: true }).fill(note);
    const response = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        candidate.url().endsWith(endpoint),
    );
    await form
      .getByRole("button", {
        name: type === "ADD" ? "Add balance" : "Remove balance",
        exact: true,
      })
      .click();
    const savedResponse = await response;
    expect(savedResponse.status()).toBe(200);
    expect(savedResponse.request().postDataJSON().date).toBe(date);
  };

  await save("ADD", "125.50", additionNote, additionDate);
  await expect(currentBalance).toHaveText(
    taka(new Prisma.Decimal(initial.balance).add("125.50").toFixed(2)),
  );
  await save("REMOVE", "45.25", removalNote, removalDate);
  const expectedBalance = new Prisma.Decimal(initial.balance)
    .add("80.25")
    .toFixed(2);
  await expect(currentBalance).toHaveText(taka(expectedBalance));
  await expect(summaryValue(page, "Total added")).toHaveText(
    taka(new Prisma.Decimal(initial.totalAdded).add("125.50").toFixed(2)),
  );
  await expect(summaryValue(page, "Total removed")).toHaveText(
    taka(new Prisma.Decimal(initial.totalRemoved).add("45.25").toFixed(2)),
  );
  const saved = await readMoney(context);
  expect(saved.balance).toBe(expectedBalance);
  expect(saved.total).toBe(initial.total + 2);
  const records = await db.companyMoneyTransaction.findMany({
    where: { createdById: actor.id },
  });
  expect(records).toHaveLength(2);
  const recordPages = new Map<string, number>();
  for (const [type, date] of [
    ["ADD", additionDate],
    ["REMOVE", removalDate],
  ]) {
    const record = records.find((item) => item.type === type)!;
    expect(record.date.toISOString().slice(0, 10)).toBe(date);
    const history = await findMoneyRecord(context, record.id);
    expect(history.item.date).toBe(date);
    recordPages.set(type, history.page);
  }
  const addition = page.getByRole("row").filter({ hasText: additionNote });
  const removal = page.getByRole("row").filter({ hasText: removalNote });
  await showHistoryPage(page, recordPages.get("ADD")!);
  await expect(addition).toContainText("Added");
  await expect(addition).toContainText(taka("125.50"));
  await expect(addition.locator(`time[datetime="${additionDate}"]`)).toHaveText(
    "Sep 30, 2026",
  );
  await showHistoryPage(page, recordPages.get("REMOVE")!);
  await expect(removal).toContainText("Removed");
  await expect(removal).toContainText(taka("45.25"));
  await expect(removal.locator(`time[datetime="${removalDate}"]`)).toHaveText(
    "Oct 1, 2026",
  );
  await expect(
    page.getByRole("columnheader", { name: "Recorded at", exact: true }),
  ).toBeVisible();

  const overdraft = await context.request.post(endpoint, {
    headers: { origin },
    data: {
      requestId: randomUUID(),
      type: "REMOVE",
      date: removalDate,
      amount: new Prisma.Decimal(saved.balance).add("0.01").toFixed(2),
      note: `Rejected overdraft ${marker}`,
    },
  });
  expect(overdraft.status()).toBe(409);
  expect(await readMoney(context)).toEqual(saved);
  expect(
    await db.companyMoneyTransaction.count({
      where: { createdById: actor.id },
    }),
  ).toBe(2);

  await page.reload();
  await expect(currentBalance).toHaveText(taka(expectedBalance));
  await showHistoryPage(page, recordPages.get("ADD")!);
  await expect(addition).toBeVisible();
  await expect(addition.locator(`time[datetime="${additionDate}"]`)).toHaveText(
    "Sep 30, 2026",
  );
  await showHistoryPage(page, recordPages.get("REMOVE")!);
  await expect(removal).toBeVisible();
  await expect(removal.locator(`time[datetime="${removalDate}"]`)).toHaveText(
    "Oct 1, 2026",
  );
  const expectVisibleControls = async () => {
    for (const name of ["Edit transaction", "Delete transaction"]) {
      await expect
        .poll(() =>
          page
            .getByRole("button", { name, exact: true })
            .first()
            .evaluate((button) => {
              const bounds = button.getBoundingClientRect();
              return bounds.left >= 0 && bounds.right <= window.innerWidth;
            }),
        )
        .toBe(true);
    }
  };
  await expectVisibleControls();
  await page.screenshot({
    path: "test-results/company-money-desktop.png",
    animations: "disabled",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".sidebar")).not.toHaveClass(/is-open/);
  await expect
    .poll(() =>
      page
        .locator(".sidebar")
        .evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(0);
  await expect(currentBalance).toBeVisible();
  await expectVisibleControls();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
  await page.screenshot({
    path: "test-results/company-money-mobile.png",
    animations: "disabled",
    fullPage: true,
  });
});

test("admins can read company money but have no controls or API permission to change it", async ({
  page,
  context,
}) => {
  const actor = await signIn(context, "ADMIN");
  const initial = await readMoney(context);
  await openCompanyMoney(page);
  await expect(summaryValue(page, "Current balance")).toHaveText(
    taka(initial.balance),
  );
  await expect(
    page.getByRole("heading", { name: "Transaction history", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("form", { name: "Update company balance", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Transaction date", { exact: true }),
  ).toHaveCount(0);
  for (const name of ["Add balance", "Remove balance"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  }
  for (const name of ["Edit transaction", "Delete transaction"]) {
    await expect(
      page
        .getByRole("region", { name: "Transaction history", exact: true })
        .getByRole("button", { name, exact: true }),
    ).toHaveCount(0);
  }
  for (const type of ["ADD", "REMOVE"] as const) {
    const rejected = await context.request.post(endpoint, {
      headers: { origin },
      data: {
        requestId: randomUUID(),
        type,
        date: additionDate,
        amount: "0.01",
      },
    });
    expect(rejected.status()).toBe(403);
  }
  const target = initial.items[0];
  const targetUrl = `${endpoint}/${target?.id ?? randomUUID()}`;
  const rejectedEdit = await context.request.patch(targetUrl, {
    headers: { origin },
    data: {
      requestId: randomUUID(),
      expectedVersion: target?.version ?? 1,
      type: "ADD",
      date: additionDate,
      amount: "0.01",
      note: "Unauthorized edit",
    },
  });
  expect(rejectedEdit.status()).toBe(403);
  const rejectedDelete = await context.request.delete(targetUrl, {
    headers: { origin },
    data: {
      requestId: randomUUID(),
      expectedVersion: target?.version ?? 1,
    },
  });
  expect(rejectedDelete.status()).toBe(403);
  expect(await readMoney(context)).toEqual(initial);
  expect(
    await db.companyMoneyTransaction.count({
      where: { createdById: actor.id },
    }),
  ).toBe(0);
});

test("super admins edit and delete transactions, with safe retries and recalculated balances", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const actor = await signIn(context, "SUPER_ADMIN");
  const initial = await readMoney(context);
  const marker = randomUUID();
  await createMoneyRecord(context, {
    type: "ADD",
    amount: "500.00",
    date: "2034-02-01",
    note: `Edit/delete reserve ${marker}`,
  });
  const addition = await createMoneyRecord(context, {
    type: "ADD",
    amount: "100.00",
    date: "2034-02-02",
    note: `Editable funding ${marker}`,
  });
  const removal = await createMoneyRecord(context, {
    type: "REMOVE",
    amount: "20.00",
    date: "2034-02-03",
    note: `Deletable withdrawal ${marker}`,
  });
  const updatedNote = `Corrected funding ${marker}`;
  const mutationBodies: Record<"PATCH" | "DELETE", Record<string, unknown>[]> =
    {
      PATCH: [],
      DELETE: [],
    };
  const targetUrl = `${endpoint}/${addition.record.id}`;
  await page.route(`**${targetUrl}`, async (route) => {
    const method = route.request().method();
    if (method !== "PATCH" && method !== "DELETE") {
      await route.continue();
      return;
    }
    mutationBodies[method].push(route.request().postDataJSON());
    if (mutationBodies[method].length === 1) {
      // Both mutations commit, but their first responses are lost. Their
      // retries must confirm the original operation and retain its version.
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await openCompanyMoney(page);
  const currentBalance = summaryValue(page, "Current balance");
  await expect(currentBalance).toHaveText(
    taka(new Prisma.Decimal(initial.balance).add("580.00").toFixed(2)),
  );
  await showHistoryPage(
    page,
    (await findMoneyRecord(context, addition.record.id)).page,
  );
  await page
    .getByRole("row")
    .filter({ hasText: addition.payload.note })
    .getByRole("button", { name: "Edit transaction", exact: true })
    .click();
  const edit = page.getByRole("form", {
    name: "Edit transaction",
    exact: true,
  });
  await expect(edit.getByLabel("Amount (BDT)", { exact: true })).toHaveValue(
    "100.00",
  );
  await expect(
    edit.getByLabel("Transaction date", { exact: true }),
  ).toHaveValue(addition.payload.date);
  await edit.getByLabel("Amount (BDT)", { exact: true }).fill("125.75");
  await edit.getByLabel("Transaction date", { exact: true }).fill("2034-02-04");
  await edit.getByLabel("Note (optional)", { exact: true }).fill(updatedNote);
  await edit.getByRole("button", { name: "Save changes", exact: true }).click();
  const retryEdit = edit.getByRole("button", {
    name: "Retry transaction",
    exact: true,
  });
  await expect(retryEdit).toBeVisible();
  for (const label of [
    "Transaction type",
    "Transaction date",
    "Amount (BDT)",
    "Note (optional)",
  ]) {
    await expect(edit.getByLabel(label, { exact: true })).toBeDisabled();
  }
  const confirmedEdit = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith(targetUrl),
  );
  await retryEdit.click();
  expect((await confirmedEdit).status()).toBe(200);
  await expect(edit).toHaveCount(0);
  expect(mutationBodies.PATCH).toHaveLength(2);
  expect(mutationBodies.PATCH[1]).toEqual(mutationBodies.PATCH[0]);
  expect(mutationBodies.PATCH[0].expectedVersion).toBe(addition.record.version);
  const afterEdit = await readMoney(context);
  expect(afterEdit.balance).toBe(
    new Prisma.Decimal(initial.balance).add("605.75").toFixed(2),
  );
  expect(afterEdit.totalAdded).toBe(
    new Prisma.Decimal(initial.totalAdded).add("625.75").toFixed(2),
  );
  expect(afterEdit.totalRemoved).toBe(
    new Prisma.Decimal(initial.totalRemoved).add("20.00").toFixed(2),
  );
  const edited = await findMoneyRecord(context, addition.record.id);
  expect(edited.item).toMatchObject({
    amount: "125.75",
    date: "2034-02-04",
    note: updatedNote,
    version: 2,
  });
  const persisted = await db.companyMoneyTransaction.findUniqueOrThrow({
    where: { id: addition.record.id },
  });
  expect(persisted.amount.toFixed(2)).toBe("125.75");
  expect(persisted.date.toISOString().slice(0, 10)).toBe("2034-02-04");
  expect(persisted.note).toBe(updatedNote);

  await page.reload();
  await expect(currentBalance).toHaveText(taka(afterEdit.balance));
  await showHistoryPage(page, edited.page);
  const editedRow = page.getByRole("row").filter({ hasText: updatedNote });
  await expect(editedRow).toContainText(taka("125.75"));
  await expect(editedRow.locator('time[datetime="2034-02-04"]')).toBeVisible();
  await editedRow
    .getByRole("button", { name: "Delete transaction", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "Delete transaction?",
    exact: true,
  });
  await expect(confirmation).toContainText(taka("125.75"));
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(confirmation).toHaveCount(0);
  expect(mutationBodies.DELETE).toHaveLength(0);
  expect(await readMoney(context)).toEqual(afterEdit);

  await editedRow
    .getByRole("button", { name: "Delete transaction", exact: true })
    .click();
  await confirmation
    .getByRole("button", { name: "Delete transaction", exact: true })
    .click();
  const retryDelete = page.getByRole("button", {
    name: "Retry deletion",
    exact: true,
  });
  await expect(retryDelete).toBeVisible();
  const afterDelete = await readMoney(context);
  expect(afterDelete.balance).toBe(
    new Prisma.Decimal(initial.balance).add("480.00").toFixed(2),
  );
  expect(
    await db.companyMoneyTransaction.findUnique({
      where: { id: addition.record.id },
    }),
  ).toBeNull();
  const confirmedDelete = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      response.url().endsWith(targetUrl),
  );
  await retryDelete.click();
  expect((await confirmedDelete).status()).toBe(200);
  await expect(retryDelete).toHaveCount(0);
  expect(mutationBodies.DELETE).toHaveLength(2);
  expect(mutationBodies.DELETE[1]).toEqual(mutationBodies.DELETE[0]);
  expect(mutationBodies.DELETE[0].expectedVersion).toBe(2);
  expect(await readMoney(context)).toEqual(afterDelete);
  const oldCreate = await context.request.post(endpoint, {
    headers: { origin },
    data: addition.payload,
  });
  expect(oldCreate.status()).toBe(409);
  expect(await readMoney(context)).toEqual(afterDelete);

  await showHistoryPage(
    page,
    (await findMoneyRecord(context, removal.record.id)).page,
  );
  await page
    .getByRole("row")
    .filter({ hasText: removal.payload.note })
    .getByRole("button", { name: "Delete transaction", exact: true })
    .click();
  const removalResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      response.url().endsWith(`${endpoint}/${removal.record.id}`),
  );
  await confirmation
    .getByRole("button", { name: "Delete transaction", exact: true })
    .click();
  expect((await removalResponse).status()).toBe(200);
  const final = await readMoney(context);
  expect(final.balance).toBe(
    new Prisma.Decimal(initial.balance).add("500.00").toFixed(2),
  );
  expect(final.totalAdded).toBe(
    new Prisma.Decimal(initial.totalAdded).add("500.00").toFixed(2),
  );
  expect(final.totalRemoved).toBe(initial.totalRemoved);
  expect(final.total).toBe(initial.total + 1);
  await expect(currentBalance).toHaveText(taka(final.balance));
  await page.reload();
  await expect(currentBalance).toHaveText(taka(final.balance));
  expect(
    await db.companyMoneyTransaction.count({
      where: { createdById: actor.id },
    }),
  ).toBe(1);
});

test("retrying an unconfirmed response never applies the same money transaction twice", async ({
  page,
  context,
}) => {
  const actor = await signIn(context, "SUPER_ADMIN");
  const initial = await readMoney(context);
  const retryDate = "2026-10-02";
  const requests: Array<{
    requestId: string;
    type: "ADD" | "REMOVE";
    date: string;
    amount: string;
    note?: string;
  }> = [];
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      // The server commits the request, but the browser never receives its
      // response. Retrying must confirm that transaction rather than add twice.
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await openCompanyMoney(page);
  const form = page.getByRole("form", {
    name: "Update company balance",
    exact: true,
  });
  await form
    .getByLabel("Transaction type", { exact: true })
    .selectOption("ADD");
  await form.getByLabel("Transaction date", { exact: true }).fill(retryDate);
  await form.getByLabel("Amount (BDT)", { exact: true }).fill("0.10");
  await form
    .getByLabel("Note (optional)", { exact: true })
    .fill(`Lost response ${randomUUID()}`);
  await form.getByRole("button", { name: "Add balance", exact: true }).click();
  const retry = form.getByRole("button", {
    name: "Retry transaction",
    exact: true,
  });
  await expect(retry).toBeVisible();
  await expect(
    form.getByLabel("Transaction type", { exact: true }),
  ).toBeDisabled();
  await expect(
    form.getByLabel("Transaction date", { exact: true }),
  ).toBeDisabled();
  await expect(
    form.getByLabel("Transaction date", { exact: true }),
  ).toHaveValue(retryDate);
  await expect(form.getByLabel("Amount (BDT)", { exact: true })).toBeDisabled();
  await expect(
    form.getByLabel("Note (optional)", { exact: true }),
  ).toBeDisabled();
  const committed = await readMoney(context);
  expect(committed.balance).toBe(
    new Prisma.Decimal(initial.balance).add("0.10").toFixed(2),
  );
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      candidate.url().endsWith(endpoint),
  );
  await retry.click();
  expect((await response).status()).toBe(200);
  await expect(retry).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests[0].date).toBe(retryDate);
  expect(requests[1]).toEqual(requests[0]);
  expect(await readMoney(context)).toEqual(committed);
  expect(
    await db.companyMoneyTransaction.count({
      where: { createdById: actor.id },
    }),
  ).toBe(1);
  const conflicting = await context.request.post(endpoint, {
    headers: { origin },
    data: { ...requests[0], amount: "0.20" },
  });
  expect(conflicting.status()).toBe(409);
  const conflictingDate = await context.request.post(endpoint, {
    headers: { origin },
    data: { ...requests[0], date: "2026-10-03" },
  });
  expect(conflictingDate.status()).toBe(409);
  expect(await readMoney(context)).toEqual(committed);
});

test("edits and deletions reject changes that would make the company balance negative", async ({
  context,
}) => {
  await signIn(context, "SUPER_ADMIN");
  const initial = await readMoney(context);
  const marker = randomUUID();
  const addition = await createMoneyRecord(context, {
    type: "ADD",
    date: "2034-02-10",
    amount: "10.00",
    note: `Guard funding ${marker}`,
  });
  const removal = await createMoneyRecord(context, {
    type: "REMOVE",
    date: "2034-02-10",
    amount: new Prisma.Decimal(initial.balance).add("10.00").toFixed(2),
    note: `Guard withdrawal ${marker}`,
  });
  const empty = await readMoney(context);
  expect(empty.balance).toBe("0.00");

  const decreaseAddition = await context.request.patch(
    `${endpoint}/${addition.record.id}`,
    {
      headers: { origin },
      data: {
        ...addition.payload,
        requestId: randomUUID(),
        expectedVersion: addition.record.version,
        amount: "9.99",
      },
    },
  );
  expect(decreaseAddition.status()).toBe(409);
  const deleteAddition = await context.request.delete(
    `${endpoint}/${addition.record.id}`,
    {
      headers: { origin },
      data: {
        requestId: randomUUID(),
        expectedVersion: addition.record.version,
      },
    },
  );
  expect(deleteAddition.status()).toBe(409);
  const increaseRemoval = await context.request.patch(
    `${endpoint}/${removal.record.id}`,
    {
      headers: { origin },
      data: {
        ...removal.payload,
        requestId: randomUUID(),
        expectedVersion: removal.record.version,
        amount: new Prisma.Decimal(removal.payload.amount)
          .add("0.01")
          .toFixed(2),
      },
    },
  );
  expect(increaseRemoval.status()).toBe(409);
  expect(await readMoney(context)).toEqual(empty);

  // Restore the opening balance so this test does not consume other fixtures'
  // funds. Deleting a withdrawal restores money before its funding is removed.
  for (const record of [removal.record, addition.record]) {
    const response = await context.request.delete(`${endpoint}/${record.id}`, {
      headers: { origin },
      data: { requestId: randomUUID(), expectedVersion: record.version },
    });
    expect(response.status()).toBe(200);
  }
  const restored = await readMoney(context);
  expect(restored.balance).toBe(initial.balance);
  expect(restored.totalAdded).toBe(initial.totalAdded);
  expect(restored.totalRemoved).toBe(initial.totalRemoved);
  expect(restored.total).toBe(initial.total);
});

test("anonymous, employee, and driver-manager users cannot open the page or access its API", async ({
  page,
  context,
}) => {
  const expectApiDenied = async (status: number) => {
    expect((await context.request.get(endpoint)).status()).toBe(status);
    for (const type of ["ADD", "REMOVE"] as const) {
      const response = await context.request.post(endpoint, {
        headers: { origin },
        data: {
          requestId: randomUUID(),
          type,
          date: additionDate,
          amount: "0.01",
        },
      });
      expect(response.status()).toBe(status);
    }
    const targetUrl = `${endpoint}/${randomUUID()}`;
    const rejectedEdit = await context.request.patch(targetUrl, {
      headers: { origin },
      data: {
        requestId: randomUUID(),
        expectedVersion: 1,
        type: "ADD",
        date: additionDate,
        amount: "0.01",
      },
    });
    expect(rejectedEdit.status()).toBe(status);
    const rejectedDelete = await context.request.delete(targetUrl, {
      headers: { origin },
      data: { requestId: randomUUID(), expectedVersion: 1 },
    });
    expect(rejectedDelete.status()).toBe(status);
  };
  await expectApiDenied(401);
  await page.goto("/admin/company-money");
  await expect(page).toHaveURL(/\/login/);
  for (const role of ["EMPLOYEE", "MANAGE_DRIVER"] as const) {
    await signIn(context, role);
    await expectApiDenied(403);
    await page.goto("/admin/company-money");
    await expect(page).toHaveURL(/\/forbidden/);
    await expect(
      page.getByRole("heading", { name: "Company money", exact: true }),
    ).toHaveCount(0);
  }
});
