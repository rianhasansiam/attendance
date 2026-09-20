import { describe, expect, it } from "vitest";
import {
  assertChallengeUsable,
  assertCredentialUsable,
  authenticationResponseSchema,
} from "../src/modules/webauthn/validation";
import {
  assertAttendanceState,
  attendanceEvidenceSchema,
} from "../src/modules/attendance/service";

const expected = {
  employeeId: "employee",
  sessionId: "session",
  purpose: "CHECK_IN",
};
const now = new Date("2026-09-19T00:00:00Z");
describe("WebAuthn verification boundaries", () => {
  it("accepts a fresh challenge bound to the same employee, session and action", () =>
    expect(() =>
      assertChallengeUsable(
        {
          ...expected,
          usedAt: null,
          expiresAt: new Date(now.getTime() + 1000),
        },
        expected,
        now,
      ),
    ).not.toThrow());
  it("rejects expired challenges including the exact expiry", () =>
    expect(() =>
      assertChallengeUsable(
        { ...expected, usedAt: null, expiresAt: now },
        expected,
        now,
      ),
    ).toThrow("expired"));
  it("rejects reused challenges", () =>
    expect(() =>
      assertChallengeUsable(
        { ...expected, usedAt: now, expiresAt: new Date(now.getTime() + 1000) },
        expected,
        now,
      ),
    ).toThrow("already been used"));
  it("rejects challenges from a different session or action", () => {
    expect(() =>
      assertChallengeUsable(
        {
          ...expected,
          sessionId: "other",
          usedAt: null,
          expiresAt: new Date(now.getTime() + 1000),
        },
        expected,
        now,
      ),
    ).toThrow("invalid");
    expect(() =>
      assertChallengeUsable(
        {
          ...expected,
          purpose: "CHECK_OUT",
          usedAt: null,
          expiresAt: new Date(now.getTime() + 1000),
        },
        expected,
        now,
      ),
    ).toThrow("invalid");
  });
  it("rejects revoked credentials regardless of approval policy", () =>
    expect(() =>
      assertCredentialUsable({ approved: true, revokedAt: now }, false),
    ).toThrow("revoked"));
  it("rejects unapproved devices when required", () =>
    expect(() =>
      assertCredentialUsable({ approved: false, revokedAt: null }, true),
    ).toThrow("approve"));
  it("never accepts frontend security flags", () => {
    expect(
      attendanceEvidenceSchema.safeParse({
        biometricVerified: true,
        insideOffice: true,
        officeWifi: true,
      }).success,
    ).toBe(false);
    expect(
      authenticationResponseSchema.safeParse({ verified: true }).success,
    ).toBe(false);
  });
});
describe("attendance state", () => {
  it("rejects duplicate check-in even after checkout", () => {
    expect(() =>
      assertAttendanceState("CHECK_IN", { checkInAt: now, checkOutAt: null }),
    ).toThrow("already");
    expect(() =>
      assertAttendanceState("CHECK_IN", { checkInAt: now, checkOutAt: now }),
    ).toThrow("already");
  });
  it("rejects checkout without checkin or after checkout", () => {
    expect(() => assertAttendanceState("CHECK_OUT", null)).toThrow("no open");
    expect(() =>
      assertAttendanceState("CHECK_OUT", { checkInAt: now, checkOutAt: now }),
    ).toThrow("no open");
    expect(() =>
      assertAttendanceState("CHECK_OUT", { checkInAt: null, checkOutAt: null }),
    ).toThrow("no open");
  });
});
