import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { Prisma } from "@prisma/client";
import { DomainError } from "../src/lib/errors";
import {
  companyMoneyInputSchema,
  companyMoneyReportQuerySchema,
  type CompanyMoneyReportData,
} from "../src/modules/company-money/contracts";

const actor = { id: "admin-1", role: "ADMIN" as const };
const record = (
  id: string,
  date = "2026-11-15",
  type: "ADD" | "REMOVE" = "ADD",
) => ({
  id,
  date: new Date(`${date}T00:00:00.000Z`),
  type,
  amount: new Prisma.Decimal("10.25"),
  note: "Office funds",
  createdAt: new Date("2026-11-15T12:00:00.000Z"),
  createdBy: { name: "Administrator", email: "admin@example.test" },
  version: 1,
});
const state: {
  records: ReturnType<typeof record>[];
  summary: Omit<CompanyMoneyReportData["summary"], "count">;
} = {
  records: [],
  summary: {
    openingBalance: "0.00",
    totalAdded: "0.00",
    totalRemoved: "0.00",
    closingBalance: "0.00",
  },
};
const findMany = mock.fn(async (query: unknown) => {
  void query;
  return state.records;
});
const queryRaw = mock.fn(async (query: Prisma.Sql) => {
  void query;
  return [state.summary];
});
const transaction = mock.fn(
  async (run: (tx: unknown) => unknown, options: unknown) => {
    void options;
    return run({ companyMoneyTransaction: { findMany }, $queryRaw: queryRaw });
  },
);
let getCompanyMoneyReportData: typeof import("../src/modules/company-money/service").getCompanyMoneyReportData;

before(async () => {
  mock.module("../src/lib/db.ts", {
    namedExports: { db: { $transaction: transaction } },
  });
  ({ getCompanyMoneyReportData } =
    await import("../src/modules/company-money/service"));
});
beforeEach(() => {
  state.records = [];
  state.summary = {
    openingBalance: "0.00",
    totalAdded: "0.00",
    totalRemoved: "0.00",
    closingBalance: "0.00",
  };
  findMany.mock.resetCalls();
  queryRaw.mock.resetCalls();
  transaction.mock.resetCalls();
});
after(() => mock.restoreAll());

for (const filters of [
  {},
  { from: "0001-01-01" },
  { to: "9999-12-31" },
  { from: "2024-02-29", to: "2024-02-29" },
]) {
  test(`valid report date range: ${JSON.stringify(filters)}`, () => {
    assert.deepEqual(companyMoneyReportQuerySchema.parse(filters), filters);
  });
}
for (const filters of [
  { from: "2026-02-29" },
  { from: "2026-04-31" },
  { to: "0000-01-01" },
  { from: "2026-11-15T00:00:00Z" },
  { from: "2026-11-30", to: "2026-11-01" },
  { from: "" },
  { page: "2" },
  { pageSize: 100 },
  { actorId: "another-admin" },
]) {
  test(`invalid report date range or scope: ${JSON.stringify(filters)}`, () => {
    assert.equal(
      companyMoneyReportQuerySchema.safeParse(filters).success,
      false,
    );
  });
}

test("transaction writes and reports share calendar-date validation", () => {
  const input = {
    requestId: "f3347cdf-c8f4-4bc9-93ce-4d559282409d",
    type: "ADD",
    amount: "0.01",
  };
  for (const date of [
    "0001-01-01",
    "2024-02-29",
    "2026-02-29",
    "0000-01-01",
    "9999-12-31",
  ]) {
    assert.equal(
      companyMoneyInputSchema.safeParse({ ...input, date }).success,
      companyMoneyReportQuerySchema.safeParse({ from: date }).success,
    );
  }
});

for (const role of ["EMPLOYEE", "MANAGE_DRIVER"] as const) {
  test(`${role} is rejected before any report database read`, async () => {
    await assert.rejects(
      () => getCompanyMoneyReportData({ ...actor, role }),
      (error) => error instanceof DomainError && error.code === "FORBIDDEN",
    );
    assert.equal(transaction.mock.callCount(), 0);
  });
}

test("all-time report exports more than one history page and retains future dates", async () => {
  state.records = Array.from({ length: 25 }, (_, index) =>
    record(`record-${index}`, "2027-01-01"),
  );
  state.summary = {
    openingBalance: "0.00",
    totalAdded: "256.25",
    totalRemoved: "0.00",
    closingBalance: "256.25",
  };
  const data = await getCompanyMoneyReportData(actor);
  assert.deepEqual(data.filters, {});
  assert.equal(data.items.length, 25);
  assert.equal(data.items[0].date, "2027-01-01");
  assert.equal(data.items[0].amount, "10.25");
  assert.equal(data.summary.count, 25);
  const query = findMany.mock.calls[0].arguments[0] as {
    where: unknown;
    orderBy: unknown;
    take: number;
    skip?: number;
  };
  assert.deepEqual(query.where, { date: {} });
  assert.deepEqual(query.orderBy, [
    { date: "desc" },
    { createdAt: "desc" },
    { id: "desc" },
  ]);
  assert.equal(query.take, 10001);
  assert.equal(query.skip, undefined);
  assert.deepEqual(queryRaw.mock.calls[0].arguments[0].values, []);
  assert.deepEqual(transaction.mock.calls[0].arguments[1], {
    isolationLevel: "RepeatableRead",
  });
  assert.ok(Number.isFinite(Date.parse(data.generatedAt)));
});

test("bounded report uses inclusive date columns and scoped SQL numeric totals", async () => {
  const filters = { from: "2026-11-01", to: "2026-11-30" };
  await getCompanyMoneyReportData(actor, filters);
  const query = findMany.mock.calls[0].arguments[0] as { where: unknown };
  assert.deepEqual(query.where, {
    date: {
      gte: new Date("2026-11-01T00:00:00Z"),
      lte: new Date("2026-11-30T00:00:00Z"),
    },
  });
  const sql = queryRaw.mock.calls[0].arguments[0];
  assert.match(sql.text, /"date" < \$1::date/);
  assert.match(sql.text, /"date" >= \$2::date/);
  assert.match(sql.text, /"date" >= \$3::date/);
  assert.match(sql.text, /WHERE "date" <= \$4::date/);
  assert.deepEqual(sql.values, [
    filters.from,
    filters.from,
    filters.from,
    filters.to,
  ]);
});

test("one-sided date ranges leave the missing side unbounded", async () => {
  await getCompanyMoneyReportData(actor, { from: "2026-11-01" });
  assert.deepEqual(
    (findMany.mock.calls[0].arguments[0] as { where: unknown }).where,
    {
      date: { gte: new Date("2026-11-01T00:00:00Z") },
    },
  );
  assert.deepEqual(queryRaw.mock.calls[0].arguments[0].values, [
    "2026-11-01",
    "2026-11-01",
    "2026-11-01",
  ]);
  await getCompanyMoneyReportData(actor, { to: "2026-11-30" });
  assert.deepEqual(
    (findMany.mock.calls[1].arguments[0] as { where: unknown }).where,
    {
      date: { lte: new Date("2026-11-30T00:00:00Z") },
    },
  );
  assert.deepEqual(queryRaw.mock.calls[1].arguments[0].values, ["2026-11-30"]);
});

test("huge exact opening balances and cents are preserved without client arithmetic", async () => {
  state.summary = {
    openingBalance: "999999999999999999999999999999999.99",
    totalAdded: "0.01",
    totalRemoved: "0.00",
    closingBalance: "1000000000000000000000000000000000.00",
  };
  const data = await getCompanyMoneyReportData(actor, { from: "2026-11-01" });
  assert.deepEqual(data.summary, { ...state.summary, count: 0 });
});

test("empty period retains its nonzero opening and closing balances", async () => {
  state.summary = {
    openingBalance: "125.37",
    totalAdded: "0.00",
    totalRemoved: "0.00",
    closingBalance: "125.37",
  };
  const data = await getCompanyMoneyReportData(actor, {
    from: "2026-11-01",
    to: "2026-11-30",
  });
  assert.deepEqual(data.items, []);
  assert.deepEqual(data.summary, { ...state.summary, count: 0 });
});

test("negative historical closing balances remain valid", async () => {
  state.summary = {
    openingBalance: "0.00",
    totalAdded: "0.00",
    totalRemoved: "100.00",
    closingBalance: "-100.00",
  };
  state.records = [record("removal", "2026-11-01", "REMOVE")];
  const data = await getCompanyMoneyReportData(
    { ...actor, role: "SUPER_ADMIN" },
    { to: "2026-11-30" },
  );
  assert.equal(data.summary.closingBalance, "-100.00");
});

test("exactly 10000 selected rows are accepted", async () => {
  state.records = Array.from({ length: 10000 }, (_, index) =>
    record(`record-${index}`),
  );
  const data = await getCompanyMoneyReportData(actor);
  assert.equal(data.summary.count, 10000);
  assert.equal(queryRaw.mock.callCount(), 1);
});

test("10001 selected rows fail without aggregation or silent truncation", async () => {
  state.records = Array.from({ length: 10001 }, (_, index) =>
    record(`record-${index}`),
  );
  await assert.rejects(
    () => getCompanyMoneyReportData(actor),
    (error) =>
      error instanceof DomainError && error.code === "REPORT_TOO_LARGE",
  );
  assert.equal(queryRaw.mock.callCount(), 0);
});

test("invalid dates are rejected before the snapshot opens", async () => {
  await assert.rejects(() =>
    getCompanyMoneyReportData(actor, { from: "2026-02-29" }),
  );
  assert.equal(transaction.mock.callCount(), 0);
});
