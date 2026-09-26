import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  rateLimit: vi.fn(),
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireSuperAdmin: mocks.authorize }));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ AUTH_URL: "https://attendance.example.test" }),
}));
vi.mock("@/lib/security", async (original) => ({
  ...(await original<object>()),
  rateLimit: mocks.rateLimit,
}));
vi.mock("@/modules/public-profile/management", () => ({
  getManagedPublicProfile: mocks.getProfile,
  updatePublicProfile: mocks.updateProfile,
}));

import { GET, PATCH } from "@/app/api/admin/users/[id]/public-profile/route";

const actor = { id: "super-admin", role: "SUPER_ADMIN" };
const profile = {
  id: "target",
  name: "Member",
  designation: "Engineer",
  phone: "+8801700123456",
  bloodGroup: "O+",
  publicDepartment: "Operations",
  homeAddress: "Dhaka",
  dateOfBirth: "2000-02-29",
};
const context = { params: Promise.resolve({ id: profile.id }) };
function request(
  body: unknown = { name: "Member" },
  origin: string | null = "https://attendance.example.test",
  crossSite = false,
) {
  return new Request(
    "https://attendance.example.test/api/admin/users/target/public-profile",
    {
      method: "PATCH",
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
  mocks.getProfile.mockResolvedValue(profile);
  mocks.updateProfile.mockResolvedValue(profile);
});

describe("public profile editor HTTP boundary", () => {
  it.each([GET, PATCH])(
    "requires Super Admin access before reading or changing profiles",
    async (handler) => {
      mocks.authorize.mockRejectedValue(
        new DomainError(
          "FORBIDDEN",
          "Super administrator access is required.",
          403,
        ),
      );
      const response = await handler(request(), context);
      expect(response.status).toBe(403);
      expect(mocks.getProfile).not.toHaveBeenCalled();
      expect(mocks.updateProfile).not.toHaveBeenCalled();
    },
  );

  it.each([
    [null, false],
    ["https://attacker.example.test", false],
    ["https://attendance.example.test", true],
  ] as const)(
    "rejects untrusted origin %s and cross-site flag %s before authorization",
    async (origin, crossSite) => {
      const response = await PATCH(
        request({ name: "Name" }, origin, crossSite),
        context,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "INVALID_ORIGIN" },
      });
      expect(mocks.authorize).not.toHaveBeenCalled();
      expect(mocks.updateProfile).not.toHaveBeenCalled();
    },
  );

  it("returns the editor DTO with no-store caching", async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ success: true, data: profile });
    expect(mocks.getProfile).toHaveBeenCalledExactlyOnceWith(actor, profile.id);
  });

  it("validates and normalizes the write before sending it to the service", async () => {
    const response = await PATCH(
      request({ name: "  Member  ", phone: " " }),
      context,
    );
    expect(response.status).toBe(200);
    expect(mocks.rateLimit).toHaveBeenCalledExactlyOnceWith(
      "admin-write:super-admin",
      120,
      60,
    );
    expect(mocks.updateProfile).toHaveBeenCalledExactlyOnceWith(
      actor,
      profile.id,
      { name: "Member", phone: null },
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    { name: "Member", role: "SUPER_ADMIN" },
    { name: "Member", dateOfBirth: "2025-02-29" },
  ])("rejects invalid request %j before writing", async (body) => {
    const response = await PATCH(request(body), context);
    expect(response.status).toBe(400);
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });

  it("stops a throttled write before profile changes", async () => {
    mocks.rateLimit.mockRejectedValue(
      new DomainError("RATE_LIMITED", "Try later.", 429),
    );
    expect((await PATCH(request(), context)).status).toBe(429);
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });
});
