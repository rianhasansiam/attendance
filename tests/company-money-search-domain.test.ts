import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { Prisma } from "@prisma/client";
import { DomainError } from "../src/lib/errors";
import {
  companyMoneyListSchema,
  companyMoneyReportQuerySchema,
} from "../src/modules/company-money/contracts";
import { companyMoneyHistoryWhere } from "../src/modules/company-money/filters";

const actor = { id: "admin-1", role: "ADMIN" as const };
const record = {
  id: "transaction-1",
  type: "ADD",
  amount: new Prisma.Decimal("100.50"),
  date: new Date("2026-11-15T00:00:00.000Z"),
  note: "Cash for office supplies",
  version: 1,
  createdAt: new Date("2026-11-15T12:00:00.000Z"),
  createdBy: null,
};
const state = { count: 23, records: [record] };
const findMany = mock.fn(async (query: unknown) => {
  void query;
  return state.records;
});
const count = mock.fn(async (query: unknown) => {
  void query;
  return state.count;
});
const queryRaw = mock.fn(async (...query: unknown[]) => {
  void query;
  return [
    { balance: "9900.25", totalAdded: "10000.75", totalRemoved: "100.50" },
  ];
});
const transaction = mock.fn(
  async (run: (tx: unknown) => unknown, options: unknown) => {
    void options;
    return run({
      companyMoneyTransaction: { findMany, count },
      $queryRaw: queryRaw,
    });
  },
);
let getCompanyMoneyOverview: typeof import("../src/modules/company-money/service").getCompanyMoneyOverview;

before(async () => {
  mock.module("../src/lib/db.ts", {
    namedExports: { db: { $transaction: transaction } },
  });
  ({ getCompanyMoneyOverview } =
    await import("../src/modules/company-money/service"));
});
beforeEach(() => {
  state.count = 23;
  state.records = [record];
  for (const fn of [findMany, count, queryRaw, transaction])
    fn.mock.resetCalls();
});
after(() => mock.restoreAll());

test("history search trims text and preserves pagination defaults", () => {
  assert.deepEqual(
    companyMoneyListSchema.parse({ search: "  Office supplies  " }),
    {
      search: "Office supplies",
      page: 1,
      pageSize: 20,
    },
  );
  assert.equal(companyMoneyListSchema.parse({ search: " " }).search, "");
  assert.equal(
    companyMoneyListSchema.safeParse({ search: "x".repeat(200) }).success,
    true,
  );
  assert.equal(
    companyMoneyListSchema.safeParse({ search: `  ${"x".repeat(200)}  ` })
      .success,
    true,
  );
});
for (const search of ["x".repeat(201), 100, [], {}, null]) {
  test(`history rejects invalid search: ${JSON.stringify(search)}`, () => {
    assert.equal(companyMoneyListSchema.safeParse({ search }).success, false);
  });
}
test("search is restricted to history and cannot change PDF report scope", () => {
  assert.equal(
    companyMoneyReportQuerySchema.safeParse({ search: "100" }).success,
    false,
  );
});

for (const search of [undefined, "", "  \t\n"]) {
  test(`missing or blank search is unfiltered: ${JSON.stringify(search)}`, () => {
    assert.deepEqual(companyMoneyHistoryWhere(search), {});
  });
}
test("notes use a case-insensitive literal substring", () => {
  assert.deepEqual(companyMoneyHistoryWhere("  OFFICE supplies  "), {
    note: { contains: "OFFICE supplies", mode: "insensitive" },
  });
});
test("note search escapes percent, underscore and backslash wildcards", () => {
  assert.deepEqual(companyMoneyHistoryWhere(String.raw`50%_C:\cash`), {
    note: { contains: String.raw`50\%\_C:\\cash`, mode: "insensitive" },
  });
});

for (const [search, amount] of [
  ["100", "100.00"],
  ["100.0", "100.00"],
  ["100.00", "100.00"],
  ["00100.50", "100.50"],
  ["1,000.50", "1000.50"],
  ["12,345,678.9", "12345678.90"],
  ["9,999,999,999.99", "9999999999.99"],
  ["000000000000100.50", "100.50"],
  ["0.01", "0.01"],
  ["  1,000.50  ", "1000.50"],
]) {
  test(`exact amount search normalizes ${search} to ${amount}`, () => {
    assert.deepEqual(companyMoneyHistoryWhere(search), {
      OR: [
        { note: { contains: search.trim(), mode: "insensitive" } },
        { amount },
      ],
    });
  });
}
for (const search of [
  "0",
  "0.00",
  "-100",
  "+100",
  "100.",
  ".50",
  "100.001",
  "10,00.50",
  "1,00,000",
  "1,000,",
  "10,000,000,000.00",
  "10000000000",
  "1e2",
  "৳100",
  "100 BDT",
  "NaN",
  "Infinity",
  "1 000.50",
]) {
  test(`invalid amount syntax still searches notes: ${search}`, () => {
    assert.deepEqual(companyMoneyHistoryWhere(search), {
      note: { contains: search, mode: "insensitive" },
    });
  });
}

test("overview shares the same filtered count and detail scope in one snapshot", async () => {
  const data = await getCompanyMoneyOverview(actor, {
    search: "  00100.50  ",
    page: 3,
    pageSize: 10,
  });
  const expectedWhere = {
    OR: [
      { note: { contains: "00100.50", mode: "insensitive" } },
      { amount: "100.50" },
    ],
  };
  const countQuery = count.mock.calls[0].arguments[0] as { where: unknown };
  const detailQuery = findMany.mock.calls[0].arguments[0] as {
    where: unknown;
    skip: number;
    take: number;
    orderBy: unknown;
  };
  assert.deepEqual(countQuery.where, expectedWhere);
  assert.strictEqual(countQuery.where, detailQuery.where);
  assert.equal(detailQuery.skip, 20);
  assert.equal(detailQuery.take, 10);
  assert.deepEqual(detailQuery.orderBy, [
    { date: "desc" },
    { createdAt: "desc" },
    { id: "desc" },
  ]);
  assert.deepEqual(transaction.mock.calls[0].arguments[1], {
    isolationLevel: "RepeatableRead",
  });
  assert.equal(data.total, 23);
  assert.equal(data.page, 3);
  assert.equal(data.pageSize, 10);
  assert.equal(data.items[0].amount, "100.50");
});
test("global balance cards remain independent of searched history", async () => {
  state.count = 0;
  state.records = [];
  const data = await getCompanyMoneyOverview(actor, {
    search: "no matching note",
  });
  assert.equal(data.balance, "9900.25");
  assert.equal(data.totalAdded, "10000.75");
  assert.equal(data.totalRemoved, "100.50");
  assert.equal(data.total, 0);
  assert.deepEqual(data.items, []);
  const sqlArguments = queryRaw.mock.calls[0].arguments;
  assert.equal(sqlArguments.length, 1);
  assert.match(
    (sqlArguments[0] as TemplateStringsArray).join(""),
    /FROM "CompanyMoneyTransaction"\s*$/,
  );
});
test("blank search restores all-history count and records", async () => {
  await getCompanyMoneyOverview(actor, { search: "  " });
  assert.deepEqual(count.mock.calls[0].arguments[0], { where: {} });
  assert.deepEqual(
    (findMany.mock.calls[0].arguments[0] as { where: unknown }).where,
    {},
  );
});
test("invalid search is rejected before any database query", async () => {
  await assert.rejects(() =>
    getCompanyMoneyOverview(actor, { search: "x".repeat(201) }),
  );
  assert.equal(transaction.mock.callCount(), 0);
});
for (const role of ["EMPLOYEE", "MANAGE_DRIVER"] as const) {
  test(`${role} cannot search company money history`, async () => {
    await assert.rejects(
      () => getCompanyMoneyOverview({ ...actor, role }, { search: "100" }),
      (error) => error instanceof DomainError && error.code === "FORBIDDEN",
    );
    assert.equal(transaction.mock.callCount(), 0);
  });
}
