import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requireSuperAdmin: vi.fn(),
  requireDriveCostManager: vi.fn(),
  sameOrigin: vi.fn(),
  rateLimit: vi.fn(),
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
  removeRecord: mocks.removeRecord,
}));

import { DELETE } from "@/app/api/admin/[resource]/[id]/route";

const superAdmin = { id: "super-admin", role: "SUPER_ADMIN" };
const deleted = { id: "employee-id" };
const context = {
  params: Promise.resolve({ resource: "employees", id: "employee-id" }),
};
const request = () =>
  new Request(
    "https://attendance.example.test/api/admin/employees/employee-id",
    {
      method: "DELETE",
      headers: { origin: "https://attendance.example.test" },
    },
  );

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireSuperAdmin.mockResolvedValue(superAdmin);
  mocks.requireAdmin.mockResolvedValue({ id: "admin", role: "ADMIN" });
  mocks.removeRecord.mockResolvedValue(deleted);
});

describe("employee deletion HTTP boundary", () => {
  it("requires super administrator access even when ordinary administrator authorization would succeed", async () => {
    mocks.requireSuperAdmin.mockRejectedValue(
      new DomainError(
        "FORBIDDEN",
        "Super administrator access is required.",
        403,
      ),
    );

    const response = await DELETE(request(), context);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "FORBIDDEN" },
    });
    expect(mocks.requireSuperAdmin).toHaveBeenCalledOnce();
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.requireDriveCostManager).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.removeRecord).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("rejects cross-origin deletion before authentication or mutations", async () => {
    mocks.sameOrigin.mockImplementation(() => {
      throw new DomainError("INVALID_ORIGIN", "Invalid origin.", 403);
    });

    const response = await DELETE(request(), context);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "INVALID_ORIGIN" },
    });
    expect(mocks.requireSuperAdmin).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.removeRecord).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("limits authorized deletion and refreshes employee displays after success", async () => {
    const deletionRequest = request();
    const response = await DELETE(deletionRequest, context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ success: true, data: deleted });
    expect(mocks.sameOrigin).toHaveBeenCalledExactlyOnceWith(deletionRequest);
    expect(mocks.requireSuperAdmin).toHaveBeenCalledOnce();
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.requireDriveCostManager).not.toHaveBeenCalled();
    expect(mocks.rateLimit).toHaveBeenCalledExactlyOnceWith(
      "admin-write:super-admin",
      120,
      60,
    );
    expect(mocks.removeRecord).toHaveBeenCalledExactlyOnceWith(
      superAdmin,
      "employees",
      "employee-id",
    );
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith("employees");
    expect(mocks.rateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeRecord.mock.invocationCallOrder[0],
    );
    expect(mocks.removeRecord.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invalidate.mock.invocationCallOrder[0],
    );
  });

  it("stops a throttled deletion before employee changes or cache invalidation", async () => {
    mocks.rateLimit.mockRejectedValue(
      new DomainError("RATE_LIMITED", "Try again later.", 429),
    );

    expect((await DELETE(request(), context)).status).toBe(429);
    expect(mocks.removeRecord).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("preserves a service authorization failure without invalidating displays", async () => {
    mocks.removeRecord.mockRejectedValue(
      new DomainError(
        "FORBIDDEN",
        "Administrator accounts cannot be deleted here.",
        403,
      ),
    );

    const response = await DELETE(request(), context);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "FORBIDDEN" },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});
