import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import type { Role } from "@prisma/client";
import { DomainError } from "../src/lib/errors";
import { authorizeRole } from "../src/modules/auth/authorization";

const state: { role: Role; authenticated: boolean } = {
  role: "ADMIN",
  authenticated: true,
};
const actor = () => ({ id: "admin-1", role: state.role });
const requireAdmin = mock.fn(async () => {
  if (!state.authenticated)
    throw new DomainError("UNAUTHENTICATED", "Please sign in.", 401);
  authorizeRole(state.role, "ADMIN");
  return actor();
});
const getCompanyMoneyOverview = mock.fn(async (...args: unknown[]) => {
  const filters = args[1] as { page: number; pageSize: number };
  return {
    balance: "1000.00",
    totalAdded: "1200.00",
    totalRemoved: "200.00",
    items: [],
    total: 0,
    page: filters.page,
    pageSize: filters.pageSize,
  };
});
let route: typeof import("../src/app/api/admin/company-money/route");
before(async () => {
  mock.module("next/navigation", { namedExports: { unstable_rethrow() {} } });
  mock.module("../src/lib/auth.ts", {
    namedExports: { requireAdmin, requireSuperAdmin: requireAdmin },
  });
  mock.module("../src/lib/security.ts", {
    namedExports: { assertSameOrigin() {}, rateLimit() {} },
  });
  mock.module("../src/modules/company-money/service.ts", {
    namedExports: {
      getCompanyMoneyOverview,
      recordCompanyMoneyTransaction() {},
    },
  });
  route = await import("../src/app/api/admin/company-money/route");
});
beforeEach(() => {
  Object.assign(state, { role: "ADMIN", authenticated: true });
  requireAdmin.mock.resetCalls();
  getCompanyMoneyOverview.mock.resetCalls();
});
after(() => mock.restoreAll());
const search = (query = "") =>
  route.GET(
    new Request(
      `https://attendance.invalid/api/admin/company-money${query ? `?${query}` : ""}`,
    ),
  );
async function expectError(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).error.code, code);
}
for (const role of ["ADMIN", "SUPER_ADMIN"] as const) {
  test(`${role} searches history through the existing uncached API`, async () => {
    state.role = role;
    const response = await search(
      "search=%20office%20supplies%20&page=2&pageSize=10",
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(getCompanyMoneyOverview.mock.calls[0].arguments, [
      actor(),
      { search: "office supplies", page: 2, pageSize: 10 },
    ]);
    assert.equal((await response.json()).data.balance, "1000.00");
  });
}
test("formatted exact amounts pass to domain without floating-point coercion", async () => {
  await search("search=1%2C000.50");
  assert.deepEqual(getCompanyMoneyOverview.mock.calls[0].arguments[1], {
    search: "1,000.50",
    page: 1,
    pageSize: 20,
  });
});
test("blank search remains an allowed all-history request", async () => {
  assert.equal((await search("search=%20%20")).status, 200);
  assert.deepEqual(getCompanyMoneyOverview.mock.calls[0].arguments[1], {
    search: "",
    page: 1,
    pageSize: 20,
  });
});
test("search text longer than 200 characters receives a validation error", async () => {
  await expectError(
    await search(`search=${"x".repeat(201)}`),
    400,
    "VALIDATION_ERROR",
  );
  assert.equal(getCompanyMoneyOverview.mock.callCount(), 0);
});
test("unknown query scope remains rejected", async () => {
  await expectError(
    await search("search=office&actorId=another-admin"),
    400,
    "VALIDATION_ERROR",
  );
  assert.equal(getCompanyMoneyOverview.mock.callCount(), 0);
});
test("anonymous users cannot search history", async () => {
  state.authenticated = false;
  await expectError(await search("search=100"), 401, "UNAUTHENTICATED");
  assert.equal(getCompanyMoneyOverview.mock.callCount(), 0);
});
for (const role of ["EMPLOYEE", "MANAGE_DRIVER"] as const) {
  test(`${role} cannot search history through HTTP`, async () => {
    state.role = role;
    await expectError(await search("search=office"), 403, "FORBIDDEN");
    assert.equal(getCompanyMoneyOverview.mock.callCount(), 0);
  });
}
