import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  session: vi.fn(),
  user: vi.fn(),
  list: vi.fn(),
  detail: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  trips: vi.fn(),
  report: vi.fn(),
  paymentStatus: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({
  db: {
    session: { findFirst: mocks.session },
    user: { findUnique: mocks.user },
    driveCost: { findMany: mocks.trips },
  },
}));
vi.mock("@/lib/security", () => ({
  assertSameOrigin: vi.fn(),
  rateLimit: mocks.rateLimit,
}));
vi.mock("@/lib/cache/invalidation", () => ({
  invalidateReferenceDisplay: vi.fn(),
}));
vi.mock("@/modules/management/service", async (original) => ({
  ...(await original<object>()),
  listRecords: mocks.list,
  getRecord: mocks.detail,
  createRecord: mocks.create,
  updateRecord: mocks.update,
  removeRecord: mocks.remove,
}));
vi.mock("@/modules/drive-costs/report", () => ({
  getDriveCostReport: mocks.report,
}));
vi.mock("@/modules/drive-costs/payment-status", () => ({
  updateDriveCostPaymentStatus: mocks.paymentStatus,
}));

import { GET as list, POST as create } from "@/app/api/admin/[resource]/route";
import {
  GET as detail,
  PATCH as update,
  DELETE as remove,
} from "@/app/api/admin/[resource]/[id]/route";
import { GET as calculate } from "@/app/api/admin/drive-costs/calculate/route";
import { GET as report } from "@/app/api/admin/drive-costs/report/route";
import { PATCH as paymentStatus } from "@/app/api/admin/drive-costs/[id]/payment-status/route";
import { resourceSchema } from "@/modules/management/service";
import type { Role } from "@/modules/auth/authorization";

function user(role: Role) {
  return {
    id: "user-1",
    role,
    status: "ACTIVE",
    googleAccountId: "google-1",
    employee: { id: "employee-1" },
  };
}

const managementActions = [
  ["list", "GET", list, mocks.list],
  ["detail", "GET", detail, mocks.detail],
  ["create", "POST", create, mocks.create],
  ["update", "PATCH", update, mocks.update],
  ["remove", "DELETE", remove, mocks.remove],
] as const;

function request(method: string, path: string) {
  return new Request(`https://attendance.example.test/api/admin/${path}`, {
    method,
    ...(method === "POST" || method === "PATCH"
      ? { body: "{}", headers: { "Content-Type": "application/json" } }
      : {}),
  });
}

function managementAction(
  action: (typeof managementActions)[number],
  resource = "drive-costs",
) {
  const [, method, handler] = action;
  return handler(request(method, resource), {
    params: Promise.resolve({ resource, id: "trip-1" }),
  });
}

const driveCostActions = [
  ...managementActions.map((action) => ({
    name: action[0],
    invoke: () => managementAction(action),
    operation: action[3],
  })),
  {
    name: "calculator",
    invoke: () =>
      calculate(request("GET", "drive-costs/calculate?from=2026-09-23")),
    operation: mocks.trips,
  },
  {
    name: "PDF report",
    invoke: () => report(request("GET", "drive-costs/report")),
    operation: mocks.report,
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({
    user: { id: "user-1" },
    sessionId: "session-1",
  });
  mocks.session.mockResolvedValue({
    id: "session-1",
    expires: new Date("2030-01-01T00:00:00Z"),
  });
  mocks.user.mockResolvedValue(user("MANAGE_DRIVER"));
  for (const [, , , operation] of managementActions)
    operation.mockResolvedValue({ id: "trip-1" });
  mocks.trips.mockResolvedValue([]);
  mocks.report.mockResolvedValue(new Response("PDF"));
});

describe("drive cost API permissions", () => {
  describe.each(["MANAGE_DRIVER", "ADMIN", "SUPER_ADMIN"] as const)(
    "%s",
    (role) => {
      it.each(driveCostActions)(
        "can use $name",
        async ({ invoke, operation }) => {
          mocks.user.mockResolvedValue(user(role));

          expect((await invoke()).status).toBe(200);
          expect(operation).toHaveBeenCalledOnce();
        },
      );
    },
  );

  it.each(driveCostActions)(
    "rejects ordinary employees from $name before accessing records",
    async ({ invoke, operation }) => {
      mocks.user.mockResolvedValue(user("EMPLOYEE"));

      const response = await invoke();

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: "FORBIDDEN" },
      });
      expect(operation).not.toHaveBeenCalled();
      expect(mocks.rateLimit).not.toHaveBeenCalled();
    },
  );

  it.each(driveCostActions)(
    "requires a current session for $name",
    async ({ invoke, operation }) => {
      mocks.session.mockResolvedValue(null);

      expect((await invoke()).status).toBe(401);
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it.each(
    resourceSchema.options.filter((resource) => resource !== "drive-costs"),
  )("does not grant MANAGE_DRIVER access to %s", async (resource) => {
    for (const action of managementActions) {
      expect((await managementAction(action, resource)).status).toBe(403);
      expect(action[3]).not.toHaveBeenCalled();
    }
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("revokes drive cost access immediately after an account role changes", async () => {
    const action = driveCostActions[0];
    expect((await action.invoke()).status).toBe(200);
    mocks.user.mockResolvedValue(user("EMPLOYEE"));

    expect((await action.invoke()).status).toBe(403);
    expect(action.operation).toHaveBeenCalledOnce();
  });
});

describe("management service permission boundary", () => {
  it.each(resourceSchema.options)(
    "rejects direct unauthorized access to %s",
    async (resource) => {
      const service = await vi.importActual<
        typeof import("@/modules/management/service")
      >("@/modules/management/service");
      const actor = user(
        resource === "drive-costs" ? "EMPLOYEE" : "MANAGE_DRIVER",
      );
      const operations = [
        () => service.listRecords(actor, resource, { page: 1, pageSize: 25 }),
        () => service.getRecord(actor, resource, "record-1"),
        () => service.createRecord(actor, resource, {}),
        () => service.updateRecord(actor, resource, "record-1", {}),
        () => service.removeRecord(actor, resource, "record-1"),
      ];

      for (const operation of operations)
        await expect(operation()).rejects.toMatchObject({
          code: "FORBIDDEN",
          status: 403,
        });
      expect(mocks.trips).not.toHaveBeenCalled();
      expect(mocks.user).not.toHaveBeenCalled();
    },
  );
});

describe("dedicated payment status API", () => {
  function updateStatus(body: unknown = { paymentStatus: "PAID" }) {
    return paymentStatus(
      new Request(
        "https://attendance.example.test/api/admin/drive-costs/trip-1/payment-status",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
      { params: Promise.resolve({ id: "trip-1" }) },
    );
  }

  it.each(["EMPLOYEE", "MANAGE_DRIVER", "ADMIN"] as const)(
    "rejects %s before changing status",
    async (role) => {
      mocks.user.mockResolvedValue(user(role));
      expect((await updateStatus()).status).toBe(403);
      expect(mocks.paymentStatus).not.toHaveBeenCalled();
    },
  );

  it("accepts only the status from a super admin without requiring trip details", async () => {
    mocks.user.mockResolvedValue(user("SUPER_ADMIN"));
    mocks.paymentStatus.mockResolvedValue({
      id: "trip-1",
      paymentStatus: "PAID",
    });
    const response = await updateStatus();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { paymentStatus: "PAID" },
    });
    expect(mocks.paymentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ role: "SUPER_ADMIN" }),
      "trip-1",
      { paymentStatus: "PAID" },
    );
  });

  it.each([
    {},
    { paymentStatus: "INVALID" },
    { paymentStatus: "PAID", kilometers: 10 },
  ])("rejects invalid status payloads %j", async (body) => {
    mocks.user.mockResolvedValue(user("SUPER_ADMIN"));
    expect((await updateStatus(body)).status).toBe(400);
    expect(mocks.paymentStatus).not.toHaveBeenCalled();
  });
});
