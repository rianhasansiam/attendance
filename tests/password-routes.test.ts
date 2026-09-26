import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@/lib/errors";
const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  sameOrigin: vi.fn(),
  limit: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/security", () => ({ assertSameOrigin: mocks.sameOrigin }));
vi.mock("@/modules/auth/auth-rate-limit", () => ({
  limitPasswordAction: mocks.limit,
}));
vi.mock("@/modules/auth/password-management", () => ({
  saveOwnPassword: mocks.save,
}));
import {
  GET as status,
  POST as manage,
} from "@/app/api/account/password/route";
const password = "a valid long application password";
const passwordInput = { newPassword: password, confirmPassword: password };
const actor = {
  id: "own-account",
  sessionId: "own-session",
  hasPassword: false,
  email: "own@example.test",
};
const request = (data: unknown) =>
  new Request("https://attendance.example.test/api/account/password", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://attendance.example.test",
    },
    body: JSON.stringify(data),
  });

describe("authenticated password API security boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireUser.mockResolvedValue(actor);
    mocks.limit.mockResolvedValue(undefined);
    mocks.save.mockResolvedValue({ signInRequired: true });
  });
  it("returns only password availability to the authenticated account", async () => {
    const response = await status();
    expect(await response.json()).toEqual({
      success: true,
      data: { hasPassword: false },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects unauthenticated password management and status requests", async () => {
    mocks.requireUser.mockRejectedValue(
      new DomainError("UNAUTHENTICATED", "Please sign in.", 401),
    );
    expect((await manage(request(passwordInput))).status).toBe(401);
    expect((await status()).status).toBe(401);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("rejects cross-origin changes before password work", async () => {
    mocks.sameOrigin.mockImplementation(() => {
      throw new DomainError("INVALID_ORIGIN", "Invalid origin.", 403);
    });
    expect((await manage(request(passwordInput))).status).toBe(403);
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("uses the authenticated actor, rejects arbitrary user IDs, and throttles before hashing", async () => {
    expect(
      (await manage(request({ ...passwordInput, userId: "someone-else" })))
        .status,
    ).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
    expect((await manage(request(passwordInput))).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(actor, passwordInput);
    expect(mocks.limit).toHaveBeenCalledWith(
      expect.any(Request),
      "manage",
      actor.id,
    );
    expect(mocks.limit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.save.mock.invocationCallOrder[0],
    );
  });
  it("requires matching passwords and minimum length on the server", async () => {
    expect(
      (
        await manage(
          request({ ...passwordInput, confirmPassword: "different password" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await manage(request({ ...passwordInput, newPassword: "short" })))
        .status,
    ).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("throttles changes before the service receives a password", async () => {
    mocks.limit.mockRejectedValue(
      new DomainError("RATE_LIMITED", "Try later.", 429),
    );
    expect((await manage(request(passwordInput))).status).toBe(429);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
