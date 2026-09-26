import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requireSuperAdmin: vi.fn(),
  requireDriveCostManager: vi.fn(),
  sameOrigin: vi.fn(),
  rateLimit: vi.fn(),
  listRecords: vi.fn(),
  getRecord: vi.fn(),
  createRecord: vi.fn(),
  updateRecord: vi.fn(),
  removeRecord: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireAdmin: mocks.requireAdmin,
  requireSuperAdmin: mocks.requireSuperAdmin,
  requireDriveCostManager: mocks.requireDriveCostManager,
}));
vi.mock("@/lib/security", () => ({
  assertSameOrigin: mocks.sameOrigin,
  rateLimit: mocks.rateLimit,
}));
vi.mock("@/lib/cache/invalidation", () => ({
  invalidateReferenceDisplay: mocks.invalidate,
}));
vi.mock("@/modules/management/service", async (original) => ({
  ...(await original<object>()),
  listRecords: mocks.listRecords,
  getRecord: mocks.getRecord,
  createRecord: mocks.createRecord,
  updateRecord: mocks.updateRecord,
  removeRecord: mocks.removeRecord,
}));

import { GET as list, POST as create } from "@/app/api/admin/[resource]/route";
import {
  GET as detail,
  PATCH as update,
  DELETE as remove,
} from "@/app/api/admin/[resource]/[id]/route";

const actor = { id: "super-admin", role: "SUPER_ADMIN" };
const target = { id: "user-id", role: "ADMIN" };
const context = {
  params: Promise.resolve({ resource: "users", id: target.id }),
};
const request = (method = "GET", body?: Record<string, unknown>) =>
  new Request("https://attendance.example.test/api/admin/users/user-id", {
    method,
    headers: {
      origin: "https://attendance.example.test",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireSuperAdmin.mockResolvedValue(actor);
  mocks.requireAdmin.mockResolvedValue({ id: "admin", role: "ADMIN" });
  mocks.listRecords.mockResolvedValue({ items: [target], total: 1 });
  mocks.getRecord.mockResolvedValue(target);
  mocks.createRecord.mockResolvedValue(target);
  mocks.updateRecord.mockResolvedValue(target);
  mocks.removeRecord.mockResolvedValue({ id: target.id });
});

describe("All Users HTTP authorization", () => {
  const actions = [
    ["list", () => list(request(), context)],
    ["detail", () => detail(request(), context)],
    ["create", () => create(request("POST", { role: "ADMIN" }), context)],
    ["role change", () => update(request("PATCH", { role: "ADMIN" }), context)],
    ["delete", () => remove(request("DELETE"), context)],
  ] as const;

  it.each(actions)(
    "requires super administrator access for %s even when administrator authorization would pass",
    async (_name, action) => {
      mocks.requireSuperAdmin.mockRejectedValue(
        new DomainError(
          "FORBIDDEN",
          "Super administrator access is required.",
          403,
        ),
      );

      const response = await action();

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: "FORBIDDEN" },
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(mocks.requireSuperAdmin).toHaveBeenCalledOnce();
      expect(mocks.requireAdmin).not.toHaveBeenCalled();
      expect(mocks.requireDriveCostManager).not.toHaveBeenCalled();
      for (const query of [
        mocks.listRecords,
        mocks.getRecord,
        mocks.createRecord,
        mocks.updateRecord,
        mocks.removeRecord,
      ])
        expect(query).not.toHaveBeenCalled();
      expect(mocks.rateLimit).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
    },
  );

  it("passes the super administrator and search pagination to the all-user list", async () => {
    const response = await list(
      new Request(
        "https://attendance.example.test/api/admin/users?q=staff&page=2&pageSize=25",
      ),
      context,
    );

    expect(response.status).toBe(200);
    expect(mocks.listRecords).toHaveBeenCalledExactlyOnceWith(actor, "users", {
      q: "staff",
      page: 2,
      pageSize: 25,
    });
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("All Users writes", () => {
  const writes = [
    [
      "role change",
      "PATCH",
      update,
      { role: "MANAGE_DRIVER" },
      mocks.updateRecord,
    ],
    ["permanent deletion", "DELETE", remove, undefined, mocks.removeRecord],
  ] as const;

  it.each(writes)(
    "rejects cross-origin %s before authentication",
    async (_name, method, action, body) => {
      mocks.sameOrigin.mockImplementation(() => {
        throw new DomainError("INVALID_ORIGIN", "Invalid origin.", 403);
      });

      expect((await action(request(method, body), context)).status).toBe(403);
      expect(mocks.requireSuperAdmin).not.toHaveBeenCalled();
      expect(mocks.rateLimit).not.toHaveBeenCalled();
      expect(mocks.updateRecord).not.toHaveBeenCalled();
      expect(mocks.removeRecord).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
    },
  );

  it.each(writes)(
    "rate-limits %s and invalidates user displays only after success",
    async (_name, method, action, body, service) => {
      const writeRequest = request(method, body);
      const response = await action(writeRequest, context);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(mocks.sameOrigin).toHaveBeenCalledExactlyOnceWith(writeRequest);
      expect(mocks.requireSuperAdmin).toHaveBeenCalledOnce();
      expect(mocks.requireAdmin).not.toHaveBeenCalled();
      expect(mocks.rateLimit).toHaveBeenCalledExactlyOnceWith(
        "admin-write:super-admin",
        120,
        60,
      );
      expect(service).toHaveBeenCalledExactlyOnceWith(
        actor,
        "users",
        target.id,
        ...(body ? [body] : []),
      );
      expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith("users");
      expect(mocks.rateLimit.mock.invocationCallOrder[0]).toBeLessThan(
        service.mock.invocationCallOrder[0],
      );
      expect(service.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.invalidate.mock.invocationCallOrder[0],
      );
    },
  );

  it.each(writes)(
    "stops throttled %s before changing users",
    async (_name, method, action, body, service) => {
      mocks.rateLimit.mockRejectedValue(
        new DomainError("RATE_LIMITED", "Try again later.", 429),
      );

      expect((await action(request(method, body), context)).status).toBe(429);
      expect(service).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["SELF_DELETE", "You cannot delete your own account.", 400],
    ["LAST_SUPER_ADMIN", "Keep at least one active super administrator.", 400],
    [
      "CONFLICT",
      "This user changed while deletion was in progress. Please refresh and try again.",
      409,
    ],
  ] as const)(
    "preserves deletion failure %s without invalidating displays",
    async (code, message, status) => {
      mocks.removeRecord.mockRejectedValue(
        new DomainError(code, message, status),
      );

      const response = await remove(request("DELETE"), context);

      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code, message },
      });
      expect(mocks.invalidate).not.toHaveBeenCalled();
    },
  );
});
