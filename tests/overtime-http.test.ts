import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import type { Role } from "@prisma/client";
import { DomainError } from "../src/lib/errors";

const origin = "https://overtime.invalid";
const employee = {
  id: "employee-1",
  employeeCode: "EMP-1",
  officeId: "office-1",
};
const state: {
  role: Role;
  authenticated: boolean;
  hasEmployee: boolean;
  recordError: DomainError | null;
} = {
  role: "SUPER_ADMIN",
  authenticated: true,
  hasEmployee: true,
  recordError: null,
};
const actor = () => ({
  id: "user-1",
  role: state.role,
  name: "Employee One",
  email: "employee@example.test",
  employee,
  sessionId: "session-1",
});
const requireSuperAdmin = mock.fn(async () => {
  if (!state.authenticated)
    throw new DomainError("UNAUTHENTICATED", "Please sign in.", 401);
  if (state.role !== "SUPER_ADMIN")
    throw new DomainError(
      "FORBIDDEN",
      "Super administrator access is required.",
      403,
    );
  return actor();
});
const requireEmployee = mock.fn(async () => {
  if (!state.authenticated)
    throw new DomainError("UNAUTHENTICATED", "Please sign in.", 401);
  if (!state.hasEmployee)
    throw new DomainError(
      "NO_EMPLOYEE",
      "An employee profile is required.",
      403,
    );
  return actor();
});
const listOvertimeRequests = mock.fn(async (...args: unknown[]) => ({
  items: [],
  total: 0,
  page: (args[1] as { page: number }).page,
  pageSize: (args[1] as { pageSize: number }).pageSize,
}));
const reviewOvertimeRequest = mock.fn(async (...args: unknown[]) => ({
  id: args[1],
  ...(args[2] as object),
}));
const preview = {
  attendanceId: "attendance-1",
  employeeName: "Employee One",
  scheduledEndAt: "2026-11-12T17:00:00.000Z",
  serverTime: "2026-11-12T18:15:00.000Z",
  extraMinutes: 75,
  eligible: true,
  timezone: "UTC",
};
const previewCheckout = mock.fn(async () => preview);
const recordAttendance = mock.fn(async (...args: unknown[]) => {
  if (state.recordError) throw state.recordError;
  return {
    id: (args[2] as { attendanceId: string }).attendanceId,
    checkOutAt: preview.serverTime,
    overtimeRequestStatus: "PENDING",
    requestedOvertimeMinutes: 75,
    approvedOvertimeMinutes: 0,
  };
});
const rateLimitUpsert = mock.fn(async () => ({ count: 1 }));
const createEvent = mock.fn(async () => ({ id: "event-1" }));

let listRoute: typeof import("../src/app/api/admin/overtime-requests/route");
let reviewRoute: typeof import("../src/app/api/admin/overtime-requests/[id]/route");
let checkoutRoute: typeof import("../src/app/api/attendance/check-out/route");
let checkinRoute: typeof import("../src/app/api/attendance/check-in/route");

before(async () => {
  // Next normally supplies this framework control-flow helper in its runtime.
  // Keep real API parsing/error envelopes without loading client React contexts.
  mock.module("next/navigation", {
    namedExports: { unstable_rethrow: () => {} },
  });
  mock.module("../src/lib/auth.ts", {
    namedExports: { requireSuperAdmin, requireEmployee },
  });
  mock.module("../src/lib/env.ts", {
    namedExports: { getEnv: () => ({ AUTH_URL: origin }) },
  });
  mock.module("../src/lib/db.ts", {
    namedExports: {
      db: {
        rateLimit: { upsert: rateLimitUpsert },
        attendanceEvent: { create: createEvent },
      },
    },
  });
  // Use production schemas while replacing only the domain writes/reads.
  const approvals = await import("../src/modules/attendance/overtime-approval");
  const attendance = await import("../src/modules/attendance/service");
  mock.module("../src/modules/attendance/overtime-approval.ts", {
    namedExports: {
      overtimeRequestFilterSchema: approvals.overtimeRequestFilterSchema,
      overtimeRequestReviewSchema: approvals.overtimeRequestReviewSchema,
      listOvertimeRequests,
      reviewOvertimeRequest,
    },
  });
  mock.module("../src/modules/attendance/service.ts", {
    namedExports: {
      attendanceEvidenceSchema: attendance.attendanceEvidenceSchema,
      checkoutEvidenceSchema: attendance.checkoutEvidenceSchema,
      lateReasonSchema: attendance.lateReasonSchema,
      previewCheckout,
      recordAttendance,
      saveLateReason: async () => {
        throw new Error("Unexpected late-reason request.");
      },
    },
  });
  listRoute = await import("../src/app/api/admin/overtime-requests/route");
  reviewRoute =
    await import("../src/app/api/admin/overtime-requests/[id]/route");
  checkoutRoute = await import("../src/app/api/attendance/check-out/route");
  checkinRoute = await import("../src/app/api/attendance/check-in/route");
});

beforeEach(() => {
  Object.assign(state, {
    role: "SUPER_ADMIN",
    authenticated: true,
    hasEmployee: true,
    recordError: null,
  });
  for (const fn of [
    requireSuperAdmin,
    requireEmployee,
    listOvertimeRequests,
    reviewOvertimeRequest,
    previewCheckout,
    recordAttendance,
    rateLimitUpsert,
    createEvent,
  ])
    fn.mock.resetCalls();
});
after(() => mock.restoreAll());

function writeRequest(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}${path}`, {
    method: path.includes("overtime-requests") ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json", Origin: origin, ...headers },
    body: JSON.stringify(body),
  });
}

function review(body: unknown, headers?: Record<string, string>) {
  return reviewRoute.PATCH(
    writeRequest("/api/admin/overtime-requests/request-1", body, headers),
    { params: Promise.resolve({ id: "request-1" }) },
  );
}

async function expectError(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, code);
  return body;
}

for (const role of ["ADMIN", "EMPLOYEE"] as const) {
  test(`${role} cannot list overtime requests through HTTP`, async () => {
    state.role = role;
    await expectError(
      await listRoute.GET(new Request(`${origin}/api/admin/overtime-requests`)),
      403,
      "FORBIDDEN",
    );
    assert.equal(requireSuperAdmin.mock.callCount(), 1);
    assert.equal(listOvertimeRequests.mock.callCount(), 0);
  });

  test(`${role} cannot review overtime requests through HTTP`, async () => {
    state.role = role;
    await expectError(await review({ status: "APPROVED" }), 403, "FORBIDDEN");
    assert.equal(requireSuperAdmin.mock.callCount(), 1);
    assert.equal(reviewOvertimeRequest.mock.callCount(), 0);
  });
}

test("list authenticates a super admin and validates/coerces filters", async () => {
  const response = await listRoute.GET(
    new Request(
      `${origin}/api/admin/overtime-requests?search=%20EMP-1%20&status=PENDING&from=2026-11-01&to=2026-11-14&departmentId=department-1&page=2&pageSize=10`,
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(requireSuperAdmin.mock.callCount(), 1);
  assert.deepEqual(listOvertimeRequests.mock.calls[0].arguments, [
    actor(),
    {
      search: "EMP-1",
      status: "PENDING",
      from: "2026-11-01",
      to: "2026-11-14",
      departmentId: "department-1",
      page: 2,
      pageSize: 10,
    },
  ]);
});

for (const query of [
  "status=INVALID",
  "requestedMinutes=120",
  "from=2026-11-14&to=2026-11-01",
]) {
  test(`list rejects invalid filters: ${query}`, async () => {
    await expectError(
      await listRoute.GET(
        new Request(`${origin}/api/admin/overtime-requests?${query}`),
      ),
      400,
      "VALIDATION_ERROR",
    );
    assert.equal(listOvertimeRequests.mock.callCount(), 0);
  });
}

for (const payload of [
  { status: "PENDING" },
  { status: "APPROVED", requestedMinutes: 120 },
  { status: "REJECTED", overtimeMinutes: 75 },
  { status: "APPROVED", rejectionReason: "Cannot accompany approval" },
]) {
  test(`review rejects invalid status or client-supplied facts: ${JSON.stringify(payload)}`, async () => {
    await expectError(await review(payload), 400, "VALIDATION_ERROR");
    assert.equal(reviewOvertimeRequest.mock.callCount(), 0);
  });
}

const invalidOriginHeaders: Record<string, string>[] = [
  { Origin: "https://attacker.invalid" },
  { Origin: origin, "sec-fetch-site": "cross-site" },
  { Origin: "" },
];
for (const headers of invalidOriginHeaders) {
  test(`review enforces same-origin headers: ${JSON.stringify(headers)}`, async () => {
    await expectError(
      await review({ status: "APPROVED" }, headers),
      403,
      "INVALID_ORIGIN",
    );
    assert.equal(requireSuperAdmin.mock.callCount(), 0);
    assert.equal(reviewOvertimeRequest.mock.callCount(), 0);
  });
}

test("review forwards a trimmed optional rejection note after authorization", async () => {
  const response = await review({
    status: "REJECTED",
    rejectionReason: "  Work was not authorized.  ",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(requireSuperAdmin.mock.callCount(), 1);
  assert.deepEqual(reviewOvertimeRequest.mock.calls[0].arguments, [
    actor(),
    "request-1",
    { status: "REJECTED", rejectionReason: "Work was not authorized." },
  ]);
  assert.equal(rateLimitUpsert.mock.callCount(), 1);
});

test("preview requires an authenticated employee profile", async () => {
  state.hasEmployee = false;
  await expectError(await checkoutRoute.GET(), 403, "NO_EMPLOYEE");
  assert.equal(requireEmployee.mock.callCount(), 1);
  assert.equal(previewCheckout.mock.callCount(), 0);
  assert.equal(requireSuperAdmin.mock.callCount(), 0);
});

test("preview denies anonymous requests", async () => {
  state.authenticated = false;
  await expectError(await checkoutRoute.GET(), 401, "UNAUTHENTICATED");
  assert.equal(previewCheckout.mock.callCount(), 0);
});

test("preview authenticates the employee and returns an uncached server estimate", async () => {
  state.role = "EMPLOYEE";
  const response = await checkoutRoute.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual((await response.json()).data, preview);
  assert.equal(requireEmployee.mock.callCount(), 1);
  assert.equal(previewCheckout.mock.callCount(), 1);
});

for (const payload of [
  {},
  { attendanceId: "attendance-1", requestedMinutes: 120 },
  { attendanceId: "attendance-1", status: "APPROVED" },
  { attendanceId: "attendance-1", overtimeReason: "short" },
  { attendanceId: "attendance-1", overtimeReason: "😀".repeat(5) },
]) {
  test(`checkout rejects invalid or forged input: ${JSON.stringify(payload)}`, async () => {
    await expectError(
      await checkoutRoute.POST(
        writeRequest("/api/attendance/check-out", payload),
      ),
      400,
      "VALIDATION_ERROR",
    );
    assert.equal(recordAttendance.mock.callCount(), 0);
    assert.equal(createEvent.mock.callCount(), 1);
  });
}

test("check-in does not accept checkout identity or overtime reason", async () => {
  await expectError(
    await checkinRoute.POST(
      writeRequest("/api/attendance/check-in", {
        attendanceId: "attendance-1",
        overtimeReason: "Completed monthly inventory.",
      }),
    ),
    400,
    "VALIDATION_ERROR",
  );
  assert.equal(recordAttendance.mock.callCount(), 0);
});

test("checkout preserves the reason-required domain error and no-store header", async () => {
  state.recordError = new DomainError(
    "OVERTIME_REASON_REQUIRED",
    "Provide an overtime reason before checking out.",
    409,
  );
  await expectError(
    await checkoutRoute.POST(
      writeRequest("/api/attendance/check-out", {
        attendanceId: "attendance-1",
      }),
    ),
    409,
    "OVERTIME_REASON_REQUIRED",
  );
  assert.equal(requireEmployee.mock.callCount(), 1);
  assert.equal(recordAttendance.mock.callCount(), 1);
  // Service failures own their audit events and must not be logged twice by HTTP.
  assert.equal(createEvent.mock.callCount(), 0);
});

test("checkout enforces same-origin before the employee guard or write", async () => {
  await expectError(
    await checkoutRoute.POST(
      writeRequest(
        "/api/attendance/check-out",
        { attendanceId: "attendance-1" },
        { Origin: "https://attacker.invalid" },
      ),
    ),
    403,
    "INVALID_ORIGIN",
  );
  assert.equal(requireEmployee.mock.callCount(), 0);
  assert.equal(recordAttendance.mock.callCount(), 0);
});

test("checkout forwards validated identity/reason and returns pending approval", async () => {
  const response = await checkoutRoute.POST(
    writeRequest("/api/attendance/check-out", {
      attendanceId: "attendance-1",
      overtimeReason: "  Completed monthly inventory and reconciled orders.  ",
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.data.overtimeRequestStatus, "PENDING");
  assert.equal(body.data.approvedOvertimeMinutes, 0);
  assert.deepEqual(recordAttendance.mock.calls[0].arguments.slice(0, 3), [
    actor(),
    "CHECK_OUT",
    {
      attendanceId: "attendance-1",
      overtimeReason: "Completed monthly inventory and reconciled orders.",
    },
  ]);
});
