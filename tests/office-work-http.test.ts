import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, mock, test } from "node:test";
import { DomainError } from "../src/lib/errors";

const origin = "https://office-work.invalid";
const state = {
  role: "SUPER_ADMIN",
  authenticated: true,
  error: null as DomainError | null,
  rateCount: 1,
};
const actor = () => ({
  id: "authenticated-user",
  role: state.role,
  status: "ACTIVE",
});
const requireUser = mock.fn(async () => {
  if (!state.authenticated)
    throw new DomainError("UNAUTHENTICATED", "Please sign in.", 401);
  return actor();
});
const overview = mock.fn(async (...args: unknown[]) => {
  if (state.error) throw state.error;
  return { items: [], total: 0, page: (args[1] as { page: number }).page };
});
const detail = mock.fn(async (...args: unknown[]) => {
  if (state.error) throw state.error;
  return {
    task: { id: args[1] },
    activities: [{ id: "event-1", action: "OFFICE_WORK_CREATED" }],
    activityTotal: 1,
    activityPage: 1,
    activityPageSize: 20,
  };
});
const create = mock.fn(async (...args: unknown[]) => {
  if (state.error) throw state.error;
  return { id: "created-task", ...(args[1] as object) };
});
const update = mock.fn(async (...args: unknown[]) => {
  if (state.error) throw state.error;
  return { id: args[1] };
});
const mutate = mock.fn(async (...args: unknown[]) => {
  if (state.error) throw state.error;
  return { id: args[1] };
});
const assignees = mock.fn(async () => {
  if (state.error) throw state.error;
  return [];
});
const rateLimit = mock.fn(async () => ({ count: state.rateCount }));
let collection: typeof import("../src/app/api/office-work/route");
let task: typeof import("../src/app/api/office-work/[id]/route");
let actions: typeof import("../src/app/api/office-work/[id]/actions/route");
let activity: typeof import("../src/app/api/office-work/[id]/activity/route");
let assigneeRoute: typeof import("../src/app/api/office-work/assignees/route");

before(async () => {
  mock.module("next/navigation", { namedExports: { unstable_rethrow() {} } });
  mock.module("../src/lib/auth.ts", { namedExports: { requireUser } });
  mock.module("../src/lib/env.ts", {
    namedExports: { getEnv: () => ({ AUTH_URL: origin }) },
  });
  mock.module("../src/lib/db.ts", {
    namedExports: { db: { rateLimit: { upsert: rateLimit } } },
  });
  mock.module("../src/modules/office-work/service.ts", {
    namedExports: {
      getOfficeWorkOverview: overview,
      getOfficeWorkTask: detail,
      createOfficeWorkTask: create,
      updateOfficeWorkTask: update,
      mutateOfficeWorkTask: mutate,
      listOfficeWorkAssignees: assignees,
    },
  });
  collection = await import("../src/app/api/office-work/route");
  task = await import("../src/app/api/office-work/[id]/route");
  actions = await import("../src/app/api/office-work/[id]/actions/route");
  activity = await import("../src/app/api/office-work/[id]/activity/route");
  assigneeRoute = await import("../src/app/api/office-work/assignees/route");
});
beforeEach(() => {
  Object.assign(state, {
    role: "SUPER_ADMIN",
    authenticated: true,
    error: null,
    rateCount: 1,
  });
  for (const fn of [
    requireUser,
    overview,
    detail,
    create,
    update,
    mutate,
    assignees,
    rateLimit,
  ])
    fn.mock.resetCalls();
});
after(() => mock.restoreAll());

const context = (id = "task-1") => ({ params: Promise.resolve({ id }) });
function request(
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: {
      ...(method !== "GET"
        ? { "Content-Type": "application/json", Origin: origin }
        : {}),
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
  return body;
}

test("all read endpoints require an authenticated persisted-session actor", async () => {
  state.authenticated = false;
  for (const response of [
    await collection.GET(request("/api/office-work")),
    await task.GET(request("/api/office-work/task-1"), context()),
    await activity.GET(request("/api/office-work/task-1/activity"), context()),
    await assigneeRoute.GET(request("/api/office-work/assignees")),
  ])
    await expectError(response, 401, "UNAUTHENTICATED");
  assert.equal(
    overview.mock.callCount() +
      detail.mock.callCount() +
      assignees.mock.callCount(),
    0,
  );
});

test("legacy ADMIN cannot read task lists, details, activity or the eligible user directory", async () => {
  state.role = "ADMIN";
  for (const response of [
    await collection.GET(request("/api/office-work")),
    await task.GET(request("/api/office-work/task-1"), context()),
    await activity.GET(request("/api/office-work/task-1/activity"), context()),
    await assigneeRoute.GET(request("/api/office-work/assignees")),
  ])
    await expectError(response, 403, "FORBIDDEN");
  assert.equal(
    overview.mock.callCount() +
      detail.mock.callCount() +
      assignees.mock.callCount(),
    0,
  );
});

test("list parses safe URL filters and passes only the authenticated actor", async () => {
  state.role = "MANAGE_DRIVER";
  const response = await collection.GET(
    request(
      "/api/office-work?view=mine&search=%20report%20&createdById=creator-2&status=DONE&page=2&pageSize=10",
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const [current, filters] = overview.mock.calls[0].arguments as [
    unknown,
    Record<string, unknown>,
  ];
  assert.deepEqual(current, actor());
  assert.equal(filters.view, "mine");
  assert.equal(filters.search, "report");
  assert.equal(filters.createdById, "creator-2");
  assert.equal(filters.status, "DONE");
  assert.equal(filters.page, 2);
  assert.equal(filters.pageSize, 10);
});

for (const query of [
  "employeeId=forged",
  "actorId=forged",
  "pageSize=101",
  "sort=unsafe",
  "status=OVERDUE",
  "from=2026-11-21&to=2026-11-01",
]) {
  test(`list rejects unsupported filter input ${query}`, async () => {
    await expectError(
      await collection.GET(request(`/api/office-work?${query}`)),
      400,
      "VALIDATION_ERROR",
    );
    assert.equal(overview.mock.callCount(), 0);
  });
}

test("write endpoints reject cross-origin and missing-origin requests before any mutation", async () => {
  const body = { action: "start", expectedVersion: 1 };
  for (const headers of [
    { Origin: "https://attacker.invalid" },
    { Origin: "" },
    { "Sec-Fetch-Site": "cross-site" },
  ] as Record<string, string>[]) {
    await expectError(
      await actions.POST(
        request("/api/office-work/task-1/actions", "POST", body, headers),
        context(),
      ),
      403,
      "INVALID_ORIGIN",
    );
  }
  assert.equal(mutate.mock.callCount(), 0);
  assert.equal(requireUser.mock.callCount(), 0);
});

test("create validates its allowlist, uses the session actor and throttles writes", async () => {
  const input = {
    title: "  Prepare report  ",
    assigneeId: "employee-2",
    requestId: randomUUID(),
  };
  const response = await collection.POST(
    request("/api/office-work", "POST", input),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(create.mock.calls[0].arguments, [
    actor(),
    { ...input, title: "Prepare report", priority: "MEDIUM" },
  ]);
  assert.equal(rateLimit.mock.callCount(), 1);
  await expectError(
    await collection.POST(
      request("/api/office-work", "POST", { ...input, createdById: "forged" }),
    ),
    400,
    "VALIDATION_ERROR",
  );
  assert.equal(create.mock.callCount(), 1);
});

test("generic edits cannot forge ownership, assignments, statuses or lifecycle timestamps", async () => {
  for (const field of ["createdById", "assigneeId", "status", "completedAt"]) {
    await expectError(
      await task.PATCH(
        request("/api/office-work/task-1", "PATCH", {
          title: "Updated",
          expectedVersion: 1,
          [field]: "forged",
        }),
        context(),
      ),
      400,
      "VALIDATION_ERROR",
    );
  }
  assert.equal(update.mock.callCount(), 0);
});

test("actions require expectedVersion and cannot expose a generic status setter", async () => {
  for (const input of [
    { action: "complete" },
    { action: "delete", expectedVersion: 1 },
    { action: "reopen", expectedVersion: 1, reason: " " },
    { action: "complete", expectedVersion: 1, status: "DONE" },
  ]) {
    await expectError(
      await actions.POST(
        request("/api/office-work/task-1/actions", "POST", input),
        context(),
      ),
      400,
      "VALIDATION_ERROR",
    );
  }
  assert.equal(mutate.mock.callCount(), 0);
  const input = {
    action: "reassign",
    expectedVersion: 2,
    assigneeId: "employee-2",
    confirmReset: true,
  };
  assert.equal(
    (
      await actions.POST(
        request("/api/office-work/task-1/actions", "POST", input),
        context(),
      )
    ).status,
    200,
  );
  assert.deepEqual(mutate.mock.calls[0].arguments, [actor(), "task-1", input]);
});

test("detail and activity validate route IDs and activity scope before reaching services", async () => {
  await expectError(
    await task.GET(request("/api/office-work/task-1"), context("../forged")),
    400,
    "VALIDATION_ERROR",
  );
  await expectError(
    await activity.GET(
      request("/api/office-work/task-1/activity?assigneeId=forged"),
      context(),
    ),
    400,
    "VALIDATION_ERROR",
  );
  assert.equal(detail.mock.callCount(), 0);
  const response = await activity.GET(
    request("/api/office-work/task-1/activity?page=2&pageSize=10"),
    context(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(detail.mock.calls[0].arguments, [
    actor(),
    "task-1",
    { page: 2, pageSize: 10 },
  ]);
  assert.deepEqual((await response.json()).data.items, [
    { id: "event-1", action: "OFFICE_WORK_CREATED" },
  ]);
});

test("object-level denial propagates identically for details and activity without leaking records", async () => {
  state.role = "EMPLOYEE";
  state.error = new DomainError("NOT_FOUND", "Task not found.", 404);
  const direct = await expectError(
    await task.GET(request("/api/office-work/task-1"), context()),
    404,
    "NOT_FOUND",
  );
  const history = await expectError(
    await activity.GET(request("/api/office-work/task-1/activity"), context()),
    404,
    "NOT_FOUND",
  );
  assert.deepEqual(direct, history);
  assert.equal("data" in history, false);
});

test("conflicts retain the server refresh message and sensitive reads never become cacheable", async () => {
  state.error = new DomainError(
    "TASK_CONFLICT",
    "This task changed. Refresh and review it before trying again.",
    409,
  );
  const body = await expectError(
    await actions.POST(
      request("/api/office-work/task-1/actions", "POST", {
        action: "complete",
        expectedVersion: 1,
      }),
      context(),
    ),
    409,
    "TASK_CONFLICT",
  );
  assert.match(body.error.message, /Refresh/);
});

test("writes reject incorrect media types, invalid JSON and exhausted mutation limits", async () => {
  await expectError(
    await collection.POST(
      new Request(`${origin}/api/office-work`, {
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
      new Request(`${origin}/api/office-work`, {
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
      request("/api/office-work", "POST", {
        title: "Report",
        assigneeId: "employee-2",
        requestId: randomUUID(),
      }),
    ),
    429,
    "RATE_LIMITED",
  );
  assert.equal(create.mock.callCount(), 0);
});
