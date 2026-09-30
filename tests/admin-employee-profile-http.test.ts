import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  rateLimit: vi.fn(),
  createProfile: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireSuperAdmin: mocks.authorize }));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ AUTH_URL: "https://attendance.example.test" }),
}));
vi.mock("@/lib/security", async (original) => ({
  ...(await original<object>()),
  rateLimit: mocks.rateLimit,
}));
vi.mock("@/lib/cache/invalidation", () => ({
  invalidateReferenceDisplay: mocks.invalidate,
}));
vi.mock("@/modules/employees/service", () => ({
  createEmployeeProfile: mocks.createProfile,
}));

import { POST } from "@/app/api/admin/users/[id]/employee-profile/route";

const actor = { id: "super-admin", role: "SUPER_ADMIN" };
const input = { employeeCode: "ADM-001", officeId: "office" };
const profile = { id: "employee-profile", userId: "admin-user", ...input };
const context = { params: Promise.resolve({ id: profile.userId }) };

function request(
  body: unknown = input,
  origin: string | null = "https://attendance.example.test",
  crossSite = false,
) {
  return new Request(
    "https://attendance.example.test/api/admin/users/admin-user/employee-profile",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(origin ? { origin } : {}),
        ...(crossSite ? { "sec-fetch-site": "cross-site" } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue(actor);
  mocks.createProfile.mockResolvedValue(profile);
});

describe("employee profile attachment HTTP boundary", () => {
  it("requires super administrator authorization before changing employment", async () => {
    mocks.authorize.mockRejectedValue(
      new DomainError("FORBIDDEN", "Super administrator access required.", 403),
    );
    const response = await POST(request(), context);
    expect(response.status).toBe(403);
    expect(mocks.createProfile).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it.each([
    [null, false],
    ["https://attacker.example.test", false],
    ["https://attendance.example.test", true],
  ] as const)(
    "rejects untrusted origin %s / cross-site %s",
    async (origin, crossSite) => {
      const response = await POST(request(input, origin, crossSite), context);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "INVALID_ORIGIN" },
      });
      expect(mocks.authorize).not.toHaveBeenCalled();
      expect(mocks.createProfile).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
    },
  );

  it("normalizes employment fields and returns the safe DTO with no-store", async () => {
    const response = await POST(
      request({ ...input, employeeCode: "  ADM-001 ", departmentId: null }),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ success: true, data: profile });
    expect(mocks.createProfile).toHaveBeenCalledExactlyOnceWith(
      actor,
      profile.userId,
      { ...input, departmentId: null },
    );
    expect(mocks.rateLimit).toHaveBeenCalledExactlyOnceWith(
      "admin-write:super-admin",
      120,
      60,
    );
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith("employees");
    expect(mocks.createProfile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invalidate.mock.invocationCallOrder[0],
    );
  });

  it.each([
    { ...input, role: "SUPER_ADMIN" },
    { ...input, userId: "different-user" },
    { ...input, email: "different@example.test" },
    { ...input, password: "new-password" },
    { employeeCode: "CODE-1" },
    { ...input, employeeCode: "invalid code" },
  ])("rejects invalid or account-changing request %j", async (body) => {
    const response = await POST(request(body), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    expect(mocks.createProfile).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("rejects invalid target IDs before writing", async () => {
    const response = await POST(request(), {
      params: Promise.resolve({ id: " " }),
    });
    expect(response.status).toBe(400);
    expect(mocks.createProfile).not.toHaveBeenCalled();
  });

  it("stops throttled requests before creating a profile", async () => {
    mocks.rateLimit.mockRejectedValue(
      new DomainError("RATE_LIMITED", "Try later.", 429),
    );
    expect((await POST(request(), context)).status).toBe(429);
    expect(mocks.createProfile).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it.each(["EMPLOYEE_PROFILE_EXISTS", "CONFLICT"])(
    "preserves conflict %s without invalidating displays",
    async (code) => {
      mocks.createProfile.mockRejectedValue(
        new DomainError(code, "Refresh the list.", 409),
      );
      const response = await POST(request(), context);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code } });
      expect(mocks.invalidate).not.toHaveBeenCalled();
    },
  );
});
