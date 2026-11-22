import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, mock, test } from "node:test";
import { DomainError } from "../src/lib/errors";

const origin = "https://work-report.invalid";
const state = {
  role: "EMPLOYEE",
  authenticated: true,
  status: "ACTIVE",
  error: null as DomainError | null,
  rateCount: 1,
};
const actor = () => ({
  id: "current-user",
  role: state.role,
  status: state.status,
});
const requireUser = mock.fn(async () => {
  if (!state.authenticated)
    throw new DomainError("UNAUTHENTICATED", "Please sign in.", 401);
  return actor();
});
function service() {
  return mock.fn(async (...args: unknown[]) => {
    if (state.error) throw state.error;
    return { id: args[1], items: [] };
  });
}
const list = service(),
  detail = service(),
  create = service(),
  update = service(),
  remove = service(),
  authors = service();
const rateLimit = mock.fn(async () => ({ count: state.rateCount }));
let collection: typeof import("../src/app/api/work-report/route");
let report: typeof import("../src/app/api/work-report/[id]/route");
let authorRoute: typeof import("../src/app/api/work-report/authors/route");

before(async () => {
  mock.module("next/navigation", { namedExports: { unstable_rethrow() {} } });
  mock.module("../src/lib/auth.ts", { namedExports: { requireUser } });
  mock.module("../src/lib/env.ts", {
    namedExports: { getEnv: () => ({ AUTH_URL: origin }) },
  });
  mock.module("../src/lib/db.ts", {
    namedExports: { db: { rateLimit: { upsert: rateLimit } } },
  });
  mock.module("../src/modules/work-report/service.ts", {
    namedExports: {
      listWorkReports: list,
      getWorkReport: detail,
      createWorkReport: create,
      updateWorkReport: update,
      deleteWorkReport: remove,
      listWorkReportAuthors: authors,
    },
  });
  collection = await import("../src/app/api/work-report/route");
  report = await import("../src/app/api/work-report/[id]/route");
  authorRoute = await import("../src/app/api/work-report/authors/route");
});
beforeEach(() => {
  Object.assign(state, {
    role: "EMPLOYEE",
    authenticated: true,
    status: "ACTIVE",
    error: null,
    rateCount: 1,
  });
  for (const fn of [
    requireUser,
    list,
    detail,
    create,
    update,
    remove,
    authors,
    rateLimit,
  ])
    fn.mock.resetCalls();
});
after(() => mock.restoreAll());
const context = (id = "report-1") => ({ params: Promise.resolve({ id }) });
function request(
  path = "",
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}/api/work-report${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...(method === "GET"
        ? {}
        : { Origin: origin, "Content-Type": "application/json" }),
      ...headers,
    },
  });
}
async function expectError(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, code);
  assert.equal("data" in body, false);
}

for (const role of ["SUPER_ADMIN", "MANAGE_DRIVER", "EMPLOYEE"]) {
  test(`${role} reaches shared reads and posts using only the authenticated identity`, async () => {
    state.role = role;
    for (const response of [
      await collection.GET(request()),
      await report.GET(request("/report-1"), context()),
      await authorRoute.GET(request("/authors")),
    ]) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.deepEqual(list.mock.calls[0].arguments, [
      actor(),
      { mine: false, page: 1, pageSize: 20 },
    ]);
    const requestId = randomUUID();
    assert.equal(
      (
        await collection.POST(
          request("", "POST", {
            title: "  Progress  ",
            content: "  Finished the report.\nNext: reconcile totals.  ",
            requestId,
          }),
        )
      ).status,
      200,
    );
    assert.deepEqual(create.mock.calls[0].arguments, [
      actor(),
      {
        title: "Progress",
        content: "Finished the report.\nNext: reconcile totals.",
        requestId,
      },
    ]);
  });

  test(`${role} receives ownership denial for another author's edit and deletion`, async () => {
    state.role = role;
    state.error = new DomainError(
      "FORBIDDEN",
      "Only the report's author can change or delete it.",
      403,
    );
    await expectError(
      await report.PATCH(
        request("/report-1", "PATCH", {
          content: "Changed",
          expectedVersion: 1,
        }),
        context(),
      ),
      403,
      "FORBIDDEN",
    );
    await expectError(
      await report.DELETE(
        request("/report-1", "DELETE", { expectedVersion: 1 }),
        context(),
      ),
      403,
      "FORBIDDEN",
    );
    assert.deepEqual(update.mock.calls[0].arguments[0], actor());
    assert.deepEqual(remove.mock.calls[0].arguments[0], actor());
  });
}

test("anonymous, inactive and legacy ADMIN actors cannot reach any report operation", async () => {
  for (const [patch, status, code] of [
    [{ authenticated: false }, 401, "UNAUTHENTICATED"],
    [{ role: "ADMIN" }, 403, "FORBIDDEN"],
    [{ status: "INACTIVE" }, 403, "FORBIDDEN"],
  ] as const) {
    Object.assign(
      state,
      { authenticated: true, role: "EMPLOYEE", status: "ACTIVE" },
      patch,
    );
    const requestId = randomUUID();
    for (const response of [
      await collection.GET(request()),
      await report.GET(request("/report-1"), context()),
      await authorRoute.GET(request("/authors")),
      await collection.POST(
        request("", "POST", { content: "Work", requestId }),
      ),
      await report.PATCH(
        request("/report-1", "PATCH", { content: "Work", expectedVersion: 1 }),
        context(),
      ),
      await report.DELETE(
        request("/report-1", "DELETE", { expectedVersion: 1 }),
        context(),
      ),
    ])
      await expectError(response, status, code);
  }
  assert.equal(
    [list, detail, create, update, remove, authors].reduce(
      (sum, fn) => sum + fn.mock.callCount(),
      0,
    ),
    0,
  );
});

test("historical browsing, author, My Reports and search filters are parsed on the server", async () => {
  const response = await collection.GET(
    request(
      "?date=2026-11-01&authorId=other-user&mine=true&search=%20shipping%20&page=2&pageSize=10",
    ),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(list.mock.calls[0].arguments, [
    actor(),
    {
      date: "2026-11-01",
      authorId: "other-user",
      mine: true,
      search: "shipping",
      page: 2,
      pageSize: 10,
    },
  ]);
  const requestId = randomUUID();
  await collection.POST(
    request("?date=2026-11-01", "POST", {
      content: "Today's progress",
      requestId,
    }),
  );
  assert.deepEqual(create.mock.calls[0].arguments, [
    actor(),
    { content: "Today's progress", requestId },
  ]);
  await authorRoute.GET(request("/authors?search=%20team%20&date=2026-11-01"));
  assert.deepEqual(authors.mock.calls[0].arguments, [
    actor(),
    { search: "team", date: "2026-11-01" },
  ]);
});

test("queries reject unsupported tenant/actor scope and unsafe pagination", async () => {
  for (const query of [
    "tenantId=forged",
    "organizationId=forged",
    "actorId=forged",
    "pageSize=101",
    "date=2026-02-30",
    "mine=yes",
    "sort=updatedAt",
  ]) {
    await expectError(
      await collection.GET(request(`?${query}`)),
      400,
      "VALIDATION_ERROR",
    );
  }
  await expectError(
    await authorRoute.GET(request("/authors?tenantId=forged")),
    400,
    "VALIDATION_ERROR",
  );
  await expectError(
    await report.GET(request("/report-1"), context("../forged")),
    400,
    "VALIDATION_ERROR",
  );
  assert.equal(
    list.mock.callCount() + authors.mock.callCount() + detail.mock.callCount(),
    0,
  );
});

test("writes allow only report text, request identity and optimistic version fields", async () => {
  const requestId = randomUUID();
  for (const field of [
    "authorId",
    "workDate",
    "tenantId",
    "organizationId",
    "createdAt",
    "updatedAt",
    "deletedAt",
  ]) {
    await expectError(
      await collection.POST(
        request("", "POST", { content: "Work", requestId, [field]: "forged" }),
      ),
      400,
      "VALIDATION_ERROR",
    );
    await expectError(
      await report.PATCH(
        request("/report-1", "PATCH", {
          content: "Work",
          expectedVersion: 1,
          [field]: "forged",
        }),
        context(),
      ),
      400,
      "VALIDATION_ERROR",
    );
    await expectError(
      await report.DELETE(
        request("/report-1", "DELETE", {
          expectedVersion: 1,
          [field]: "forged",
        }),
        context(),
      ),
      400,
      "VALIDATION_ERROR",
    );
  }
  for (const content of [" ", "x".repeat(10001)])
    await expectError(
      await collection.POST(request("", "POST", { content, requestId })),
      400,
      "VALIDATION_ERROR",
    );
  await expectError(
    await report.DELETE(request("/report-1", "DELETE", {}), context()),
    400,
    "VALIDATION_ERROR",
  );
  assert.equal(
    create.mock.callCount() + update.mock.callCount() + remove.mock.callCount(),
    0,
  );
});

test("CSRF is enforced for creation, editing and deletion before authentication", async () => {
  for (const headers of [
    { Origin: "https://attacker.invalid" },
    { Origin: "" },
    { "Sec-Fetch-Site": "cross-site" },
  ] as Record<string, string>[]) {
    for (const response of [
      await collection.POST(
        request(
          "",
          "POST",
          { content: "Work", requestId: randomUUID() },
          headers,
        ),
      ),
      await report.PATCH(
        request(
          "/report-1",
          "PATCH",
          { content: "Work", expectedVersion: 1 },
          headers,
        ),
        context(),
      ),
      await report.DELETE(
        request("/report-1", "DELETE", { expectedVersion: 1 }, headers),
        context(),
      ),
    ])
      await expectError(response, 403, "INVALID_ORIGIN");
  }
  assert.equal(requireUser.mock.callCount(), 0);
});

test("deleted reads and conflicts retain safe no-store errors", async () => {
  state.error = new DomainError("NOT_FOUND", "Report not found.", 404);
  await expectError(
    await report.GET(request("/report-1"), context()),
    404,
    "NOT_FOUND",
  );
  state.error = new DomainError(
    "WORK_REPORT_CONFLICT",
    "Refresh this report.",
    409,
  );
  await expectError(
    await report.PATCH(
      request("/report-1", "PATCH", { content: "Work", expectedVersion: 1 }),
      context(),
    ),
    409,
    "WORK_REPORT_CONFLICT",
  );
});

test("request parsing and rate limiting retain existing protections", async () => {
  await expectError(
    await collection.POST(
      new Request(`${origin}/api/work-report`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "text/plain" },
        body: "{}",
      }),
    ),
    415,
    "UNSUPPORTED_MEDIA_TYPE",
  );
  await expectError(
    await collection.POST(
      new Request(`${origin}/api/work-report`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: "{",
      }),
    ),
    400,
    "INVALID_JSON",
  );
  state.rateCount = 121;
  await expectError(
    await collection.POST(
      request("", "POST", { content: "Work", requestId: randomUUID() }),
    ),
    429,
    "RATE_LIMITED",
  );
  assert.equal(create.mock.callCount(), 0);
});
