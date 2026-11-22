import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import type { Role } from "@prisma/client";
import { DomainError } from "../src/lib/errors";

const state: {
  role: Role;
  employee: { id: string } | null;
  authenticated: boolean;
} = { role: "SUPER_ADMIN", employee: null, authenticated: true };
const requireUser = mock.fn(async () => {
  if (!state.authenticated)
    throw new DomainError("UNAUTHENTICATED", "Please sign in.", 401);
  return {
    id: "current-user",
    role: state.role,
    employee: state.employee,
  };
});
const lateApprovals = mock.fn<(input: unknown) => Promise<number>>(
  async () => 3,
);
const overtimeRequests = mock.fn<(input: unknown) => Promise<number>>(
  async () => 4,
);
const leaves = mock.fn(async (input: unknown) => {
  const { where } = input as { where: { employeeId?: string } };
  return where.employeeId ? 1 : 7;
});
const officeWork = mock.fn<(input: unknown) => Promise<number>>(async () => 2);
const queries = [lateApprovals, overtimeRequests, leaves, officeWork];
let route: typeof import("../src/app/api/notifications/route");

before(async () => {
  mock.module("next/navigation", { namedExports: { unstable_rethrow() {} } });
  mock.module("../src/lib/auth.ts", { namedExports: { requireUser } });
  mock.module("../src/lib/db.ts", {
    namedExports: {
      db: {
        lateApprovalRequest: { count: lateApprovals },
        overtimeRequest: { count: overtimeRequests },
        leave: { count: leaves },
        officeWorkTask: { count: officeWork },
      },
    },
  });
  route = await import("../src/app/api/notifications/route");
});
beforeEach(() => {
  Object.assign(state, {
    role: "SUPER_ADMIN",
    employee: null,
    authenticated: true,
  });
  requireUser.mock.resetCalls();
  for (const query of queries) query.mock.resetCalls();
});
after(() => mock.restoreAll());

async function counts() {
  const response = await route.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.success, true);
  return body.data;
}

test("anonymous requests cannot read any notification counts", async () => {
  state.authenticated = false;
  const response = await route.GET();
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).error.code, "UNAUTHENTICATED");
  assert.ok(queries.every((query) => query.mock.callCount() === 0));
});

test("super admins receive pending approval and unarchived task counts only", async () => {
  assert.deepEqual(await counts(), {
    "/admin/late-approvals": 3,
    "/admin/overtime-requests": 4,
    "/admin/leaves": 7,
    "/office-work": 2,
  });
  for (const query of [lateApprovals, overtimeRequests, leaves])
    assert.deepEqual(query.mock.calls[0].arguments, [
      { where: { status: "PENDING" } },
    ]);
  assert.deepEqual(officeWork.mock.calls[0].arguments, [
    { where: { status: "PENDING", archivedAt: null } },
  ]);
});

test("admins cannot access overtime or Office Work counts", async () => {
  state.role = "ADMIN";
  assert.deepEqual(await counts(), {
    "/admin/late-approvals": 3,
    "/admin/leaves": 7,
  });
  assert.equal(overtimeRequests.mock.callCount(), 0);
  assert.equal(officeWork.mock.callCount(), 0);
});

test("employees see only their own leaves and assigned pending tasks", async () => {
  state.role = "EMPLOYEE";
  state.employee = { id: "current-employee" };
  assert.deepEqual(await counts(), {
    "/employee/leaves": 1,
    "/office-work": 2,
  });
  assert.equal(lateApprovals.mock.callCount(), 0);
  assert.equal(overtimeRequests.mock.callCount(), 0);
  assert.deepEqual(leaves.mock.calls[0].arguments, [
    { where: { employeeId: "current-employee", status: "PENDING" } },
  ]);
  assert.deepEqual(officeWork.mock.calls[0].arguments, [
    {
      where: {
        assigneeId: "current-user",
        status: "PENDING",
        archivedAt: null,
      },
    },
  ]);
});

test("driver managers use the same task visibility as Office Work", async () => {
  state.role = "MANAGE_DRIVER";
  state.employee = { id: "driver-employee" };
  assert.deepEqual(await counts(), {
    "/employee/leaves": 1,
    "/office-work": 2,
  });
  assert.equal(lateApprovals.mock.callCount(), 0);
  assert.equal(overtimeRequests.mock.callCount(), 0);
  assert.deepEqual(officeWork.mock.calls[0].arguments, [
    { where: { status: "PENDING", archivedAt: null } },
  ]);
});

test("admin and employee leave destinations have separate scopes for the same account", async () => {
  state.employee = { id: "admin-employee" };
  const result = await counts();
  assert.equal(result["/admin/leaves"], 7);
  assert.equal(result["/employee/leaves"], 1);
  assert.deepEqual(
    leaves.mock.calls.map((call) => call.arguments),
    [
      [{ where: { status: "PENDING" } }],
      [{ where: { employeeId: "admin-employee", status: "PENDING" } }],
    ],
  );
});
