import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmployeeActor } from "../src/modules/webauthn/service";
import { DomainError } from "../src/lib/errors";

const mocks = vi.hoisted(() => ({
  office: vi.fn(),
  credentials: vi.fn(),
  createChallenge: vi.fn(),
  generateOptions: vi.fn(),
  requireEmployee: vi.fn(),
  assertSameOrigin: vi.fn(),
  rateLimit: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    office: { findUniqueOrThrow: mocks.office },
    webAuthnCredential: { findMany: mocks.credentials },
    webAuthnChallenge: { create: mocks.createChallenge },
  },
}));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ WEBAUTHN_RP_ID: "attendance.example" }),
}));
vi.mock("@/lib/auth", () => ({ requireEmployee: mocks.requireEmployee }));
vi.mock("@/lib/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  rateLimit: mocks.rateLimit,
}));
vi.mock("@simplewebauthn/server", () => ({
  generateAuthenticationOptions: mocks.generateOptions,
  generateRegistrationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
}));
import { authenticationOptions } from "../src/modules/webauthn/service";
import { POST } from "../src/app/api/webauthn/authenticate/options/route";

const actor = {
  id: "user",
  sessionId: "session",
  employee: { id: "employee", officeId: "office" },
} as EmployeeActor;
const office = { active: true, requireWebAuthn: true, requireGeofence: true };
const options = { challenge: "challenge", rpId: "attendance.example" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireEmployee.mockResolvedValue(actor);
  mocks.office.mockResolvedValue(office);
  mocks.credentials.mockResolvedValue([
    { credentialId: "registered-key", transports: ["internal"] },
  ]);
  mocks.generateOptions.mockResolvedValue(options);
  mocks.createChallenge.mockResolvedValue({ id: "challenge-id" });
});

describe("current attendance verification requirements", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "returns current geofence policy with passkey=%s GPS=%s",
    async (requireWebAuthn, requireGeofence) => {
      mocks.office.mockResolvedValue({
        ...office,
        requireWebAuthn,
        requireGeofence,
      });
      const response = await authenticationOptions(actor, "CHECK_IN");
      expect(response).toEqual(
        requireWebAuthn
          ? {
              required: true,
              requireGeofence,
              challengeId: "challenge-id",
              options,
            }
          : { required: false, requireGeofence },
      );
      expect(mocks.office).toHaveBeenCalledExactlyOnceWith({
        where: { id: "office" },
      });
      if (requireWebAuthn) {
        expect(mocks.credentials).toHaveBeenCalledExactlyOnceWith({
          where: {
            employeeId: "employee",
            revokedAt: null,
            approved: true,
          },
        });
        expect(mocks.createChallenge).toHaveBeenCalledExactlyOnceWith({
          data: {
            employeeId: "employee",
            sessionId: "session",
            purpose: "CHECK_IN",
            challenge: "challenge",
            expiresAt: expect.any(Date),
          },
          select: { id: true },
        });
        expect(mocks.generateOptions.mock.calls[0][0]).toMatchObject({
          userVerification: "required",
          timeout: 60_000,
        });
      } else {
        expect(mocks.credentials).not.toHaveBeenCalled();
        expect(mocks.generateOptions).not.toHaveBeenCalled();
        expect(mocks.createChallenge).not.toHaveBeenCalled();
      }
    },
  );

  it("re-reads changed office policy for the next attempt and binds checkout challenges to checkout", async () => {
    mocks.office.mockResolvedValueOnce({
      ...office,
      requireWebAuthn: false,
      requireGeofence: false,
    });
    expect(await authenticationOptions(actor, "CHECK_IN")).toEqual({
      required: false,
      requireGeofence: false,
    });
    expect(await authenticationOptions(actor, "CHECK_OUT")).toMatchObject({
      required: true,
      requireGeofence: true,
    });
    expect(mocks.office).toHaveBeenCalledTimes(2);
    expect(mocks.createChallenge.mock.calls[0][0].data.purpose).toBe(
      "CHECK_OUT",
    );
  });

  it("still rejects inactive offices before disclosing requirements or creating a challenge", async () => {
    mocks.office.mockResolvedValue({
      ...office,
      active: false,
      requireWebAuthn: false,
    });
    await expect(
      authenticationOptions(actor, "CHECK_OUT"),
    ).rejects.toMatchObject({ code: "OFFICE_INACTIVE" });
    expect(mocks.createChallenge).not.toHaveBeenCalled();
  });
});

describe("verification options route timing", () => {
  const request = (timing = false) =>
    new Request(
      "https://attendance.example/api/webauthn/authenticate/options",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(timing ? { "x-attendance-timing": "1" } : {}),
        },
        body: JSON.stringify({ action: "CHECK_OUT" }),
      },
    );

  it.each([false, true])(
    "preserves options and security checks with timing opted in=%s",
    async (timing) => {
      const response = await POST(request(timing));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        success: true,
        data: {
          required: true,
          requireGeofence: true,
          challengeId: "challenge-id",
          options,
        },
      });
      expect(mocks.assertSameOrigin).toHaveBeenCalledOnce();
      expect(mocks.requireEmployee).toHaveBeenCalledOnce();
      expect(mocks.rateLimit).toHaveBeenCalledExactlyOnceWith(
        "passkey-authenticate:user",
        15,
        60,
      );
      expect(response.headers.has("Server-Timing")).toBe(timing);
      if (timing) {
        for (const phase of [
          "auth",
          "rate_limit",
          "initial_policy",
          "authoritative_reads",
          "challenge",
          "total",
        ])
          expect(response.headers.get("Server-Timing")).toContain(
            `${phase};dur=`,
          );
      }
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    },
  );

  it("still rejects the origin before authentication when opted in", async () => {
    mocks.assertSameOrigin.mockImplementation(() => {
      throw new DomainError("INVALID_ORIGIN", "Invalid origin.", 403);
    });
    const response = await POST(request(true));
    expect(response.status).toBe(403);
    expect(mocks.requireEmployee).not.toHaveBeenCalled();
    expect(mocks.office).not.toHaveBeenCalled();
    expect(response.headers.get("Server-Timing")).toMatch(/^total;dur=/);
  });
});
