import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import type { Role } from "@prisma/client";
import { DomainError } from "../src/lib/errors";
import { authorizeRole } from "../src/modules/auth/authorization";

const state: {
  authenticated: boolean;
  role: Role;
  locale: string;
  rateLimited: boolean;
  reportError: DomainError | null;
} = {
  authenticated: true,
  role: "ADMIN",
  locale: "en",
  rateLimited: false,
  reportError: null,
};
const actor = () => ({ id: "admin-1", role: state.role });
const requireAdmin = mock.fn(async () => {
  if (!state.authenticated)
    throw new DomainError("UNAUTHENTICATED", "Please sign in.", 401);
  authorizeRole(state.role, "ADMIN");
  return actor();
});
const rateLimit = mock.fn(
  async (_key: string, _limit: number, _seconds: number) => {
    void [_key, _limit, _seconds];
    if (state.rateLimited)
      throw new DomainError("RATE_LIMITED", "Too many requests.", 429);
  },
);
const getCompanyMoneyReport = mock.fn(async (..._args: unknown[]) => {
  void _args;
  if (state.reportError) throw state.reportError;
  return new Response("%PDF-test", {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition":
        'attachment; filename="company-money-all-dates.pdf"',
    },
  });
});
let route: typeof import("../src/app/api/admin/company-money/report/route");

before(async () => {
  mock.module("next/navigation", { namedExports: { unstable_rethrow() {} } });
  mock.module("next-intl/server", {
    namedExports: { getLocale: async () => state.locale },
  });
  mock.module("../src/lib/auth.ts", { namedExports: { requireAdmin } });
  mock.module("../src/lib/security.ts", { namedExports: { rateLimit } });
  mock.module("../src/modules/company-money/report.ts", {
    namedExports: { getCompanyMoneyReport },
  });
  route = await import("../src/app/api/admin/company-money/report/route");
});
beforeEach(() => {
  Object.assign(state, {
    authenticated: true,
    role: "ADMIN",
    locale: "en",
    rateLimited: false,
    reportError: null,
  });
  requireAdmin.mock.resetCalls();
  rateLimit.mock.resetCalls();
  getCompanyMoneyReport.mock.resetCalls();
});
after(() => mock.restoreAll());

const download = (query = "") =>
  route.GET(
    new Request(
      `https://attendance.invalid/api/admin/company-money/report${query ? `?${query}` : ""}`,
    ),
  );
async function expectError(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).error.code, code);
}

for (const role of ["ADMIN", "SUPER_ADMIN"] as const) {
  test(`${role} downloads an uncached report with validated inclusive filters`, async () => {
    state.role = role;
    state.locale = "zh-CN";
    const response = await download("from=2026-11-01&to=2026-11-30");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.deepEqual(rateLimit.mock.calls[0].arguments, [
      "company-money-reports:admin-1",
      30,
      60,
    ]);
    assert.deepEqual(getCompanyMoneyReport.mock.calls[0].arguments, [
      actor(),
      { from: "2026-11-01", to: "2026-11-30" },
      "zh-CN",
    ]);
  });
}
test("all-time report has no date or pagination filters and unsupported locale falls back", async () => {
  state.locale = "unsupported";
  assert.equal((await download()).status, 200);
  assert.deepEqual(getCompanyMoneyReport.mock.calls[0].arguments, [
    actor(),
    {},
    "en",
  ]);
});
test("anonymous users are rejected before rate limiting or generation", async () => {
  state.authenticated = false;
  await expectError(await download(), 401, "UNAUTHENTICATED");
  assert.equal(rateLimit.mock.callCount(), 0);
  assert.equal(getCompanyMoneyReport.mock.callCount(), 0);
});
for (const role of ["EMPLOYEE", "MANAGE_DRIVER"] as const) {
  test(`${role} cannot download company money reports`, async () => {
    state.role = role;
    await expectError(await download(), 403, "FORBIDDEN");
    assert.equal(rateLimit.mock.callCount(), 0);
    assert.equal(getCompanyMoneyReport.mock.callCount(), 0);
  });
}
for (const query of [
  "from=2026-02-29",
  "from=2026-11-30&to=2026-11-01",
  "to=0000-01-01",
  "page=2",
  "pageSize=20",
  "actorId=another-admin",
]) {
  test(`invalid report filter is rejected: ${query}`, async () => {
    await expectError(await download(query), 400, "VALIDATION_ERROR");
    assert.equal(getCompanyMoneyReport.mock.callCount(), 0);
  });
}
test("rate limiting prevents report generation", async () => {
  state.rateLimited = true;
  await expectError(await download(), 429, "RATE_LIMITED");
  assert.equal(getCompanyMoneyReport.mock.callCount(), 0);
});
test("oversized report returns a structured localized error code", async () => {
  state.reportError = new DomainError(
    "REPORT_TOO_LARGE",
    "Narrow the date range.",
  );
  await expectError(await download(), 400, "REPORT_TOO_LARGE");
});
