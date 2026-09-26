import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@/lib/errors";
const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  sameOrigin: vi.fn(),
  limit: vi.fn(),
  save: vi.fn(),
  request: vi.fn(),
  reset: vi.fn(),
  after: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/security", () => ({ assertSameOrigin: mocks.sameOrigin }));
vi.mock("@/modules/auth/auth-rate-limit", () => ({
  limitPasswordAction: mocks.limit,
}));
vi.mock("@/modules/auth/password-management", () => ({
  saveOwnPassword: mocks.save,
}));
vi.mock("@/modules/auth/password-reset", () => ({
  requestPasswordReset: mocks.request,
  resetPassword: mocks.reset,
  FORGOT_PASSWORD_MESSAGE:
    "If an account exists for this email, password reset instructions have been sent.",
}));
vi.mock("next/server", () => ({ after: mocks.after }));
import {
  GET as status,
  POST as manage,
} from "@/app/api/account/password/route";
import { POST as forgot } from "@/app/api/password/forgot/route";
import { POST as reset } from "@/app/api/password/reset/route";
const password = "a valid long application password";
const passwordInput = { newPassword: password, confirmPassword: password };
const token = "a".repeat(64);
const actor = {
  id: "own-account",
  sessionId: "own-session",
  hasPassword: false,
  email: "own@example.test",
};
const request = (data: unknown) =>
  new Request("https://attendance.example.test/api/password", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://attendance.example.test",
    },
    body: JSON.stringify(data),
  });

describe("password API security boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireUser.mockResolvedValue(actor);
    mocks.limit.mockResolvedValue(undefined);
    mocks.save.mockResolvedValue({ signInRequired: true });
    mocks.reset.mockResolvedValue({ signInRequired: true });
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
  it.each([
    ["manage", manage, passwordInput],
    ["forgot", forgot, { email: "own@example.test" }],
    ["reset", reset, { ...passwordInput, token }],
  ] as const)(
    "rejects cross-origin %s before password or token work",
    async (_name, route, input) => {
      mocks.sameOrigin.mockImplementation(() => {
        throw new DomainError("INVALID_ORIGIN", "Invalid origin.", 403);
      });
      expect((await route(request(input))).status).toBe(403);
      expect(mocks.limit).not.toHaveBeenCalled();
      expect(mocks.save).not.toHaveBeenCalled();
      expect(mocks.request).not.toHaveBeenCalled();
      expect(mocks.reset).not.toHaveBeenCalled();
    },
  );
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
  it("requires matching passwords on the server", async () => {
    expect(
      (
        await reset(
          request({
            ...passwordInput,
            token,
            confirmPassword: "different password",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await manage(request({ ...passwordInput, newPassword: "short" })))
        .status,
    ).toBe(400);
    expect(mocks.reset).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("throttles resets before the service receives a token", async () => {
    mocks.limit.mockRejectedValue(
      new DomainError("RATE_LIMITED", "Try later.", 429),
    );
    expect((await reset(request({ ...passwordInput, token }))).status).toBe(
      429,
    );
    expect(mocks.reset).not.toHaveBeenCalled();
  });
  it("normalizes forgot email and delays account lookup and delivery until after response", async () => {
    const response = await forgot(request({ email: "  OWN@EXAMPLE.TEST  " }));
    expect(response.status).toBe(200);
    expect(mocks.limit).toHaveBeenCalledWith(
      expect.any(Request),
      "forgot",
      "own@example.test",
    );
    expect(mocks.after).toHaveBeenCalledOnce();
    expect(mocks.request).not.toHaveBeenCalled();
    await mocks.after.mock.calls[0][0]();
    expect(mocks.request).toHaveBeenCalledWith({ email: "own@example.test" });
  });
  it("returns the identical forgot response for unknown, known, and throttled identifiers", async () => {
    const known = await forgot(request({ email: "own@example.test" }));
    const unknown = await forgot(request({ email: "unknown@example.test" }));
    mocks.limit.mockRejectedValueOnce(
      new DomainError("RATE_LIMITED", "Try later.", 429),
    );
    const limited = await forgot(request({ email: "own@example.test" }));
    expect([known.status, unknown.status, limited.status]).toEqual([
      200, 200, 200,
    ]);
    const expected = await known.json();
    expect(await unknown.json()).toEqual(expected);
    expect(await limited.json()).toEqual(expected);
    expect(mocks.after).toHaveBeenCalledTimes(2);
  });
  it("suppresses account and SMTP error details in deferred failures", async () => {
    mocks.request.mockRejectedValue(
      new Error("secret-token smtp-password account@example.test"),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await forgot(request({ email: "own@example.test" }));
      await mocks.after.mock.calls[0][0]();
      expect(await response.text()).not.toContain("secret-token");
      expect(JSON.stringify(log.mock.calls)).not.toContain("smtp-password");
      expect(log).toHaveBeenCalledWith(
        "Password reset request could not be completed",
      );
    } finally {
      log.mockRestore();
    }
  });
});
