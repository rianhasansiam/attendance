import { describe, expect, it } from "vitest";
import {
  authorizeGoogle,
  authorizeRole,
  isEmployeeRole,
  type Role,
} from "@/modules/auth/authorization";
import { parseEnv } from "@/lib/env";
const user = {
  email: "staff@example.com",
  status: "ACTIVE",
  role: "EMPLOYEE" as const,
  googleAccountId: null,
};
const identity = {
  email: user.email,
  email_verified: true,
  sub: "google-123",
  hd: "example.com",
};
describe("Google authorization", () => {
  it("accepts a verified, pre-authorized employee", () =>
    expect(() => authorizeGoogle(identity, user)).not.toThrow());
  it("rejects unknown Google accounts", () =>
    expect(() => authorizeGoogle(identity, null)).toThrow(
      "not been authorized",
    ));
  it("rejects inactive employees", () =>
    expect(() =>
      authorizeGoogle(identity, { ...user, status: "INACTIVE" }),
    ).toThrow("not active"));
  it("rejects unverified Google email", () =>
    expect(() =>
      authorizeGoogle({ ...identity, email_verified: false }, user),
    ).toThrow("verified"));
  it("requires the company Workspace domain", () =>
    expect(() => authorizeGoogle(identity, user, "other.com")).toThrow(
      "company",
    ));
  it("does not treat an email suffix alone as Workspace identity", () =>
    expect(() =>
      authorizeGoogle({ ...identity, hd: undefined }, user, "example.com"),
    ).toThrow("company"));
  it("binds the immutable Google subject", () =>
    expect(() =>
      authorizeGoogle(identity, { ...user, googleAccountId: "other" }),
    ).toThrow("identity"));
  it("denies employees admin routes", () =>
    expect(() => authorizeRole("EMPLOYEE", "ADMIN")).toThrow("access"));
  it("reserves superadmin functions", () =>
    expect(() => authorizeRole("ADMIN", "SUPER_ADMIN")).toThrow("access"));
  it("permits superadmin across roles", () =>
    expect(() => authorizeRole("SUPER_ADMIN", "ADMIN")).not.toThrow());
});
describe("drive-cost manager permissions", () => {
  it("retains employee access and adds drive-cost access", () => {
    expect(isEmployeeRole("MANAGE_DRIVER")).toBe(true);
    expect(() => authorizeRole("MANAGE_DRIVER", "EMPLOYEE")).not.toThrow();
    expect(() => authorizeRole("MANAGE_DRIVER", "MANAGE_DRIVER")).not.toThrow();
  });
  it.each(["ADMIN", "SUPER_ADMIN"] as const)(
    "cannot enter %s areas",
    (required) => {
      expect(() => authorizeRole("MANAGE_DRIVER", required)).toThrow("access");
    },
  );
  it("does not grant ordinary employees drive-cost access", () => {
    expect(() => authorizeRole("EMPLOYEE", "MANAGE_DRIVER")).toThrow("access");
  });
  it.each(["ADMIN", "SUPER_ADMIN"] as const)(
    "preserves drive-cost access for %s",
    (role) => {
      expect(() => authorizeRole(role, "MANAGE_DRIVER")).not.toThrow();
    },
  );
  it("rejects unknown roles instead of allowing access", () => {
    expect(() => authorizeRole("UNKNOWN" as Role, "EMPLOYEE")).toThrow(
      "access",
    );
  });
});
describe("environment validation", () => {
  const env = {
    DATABASE_URL: "postgresql://localhost/attendance",
    AUTH_SECRET: "a".repeat(32),
    AUTH_URL: "http://localhost:3000",
    GOOGLE_CLIENT_ID: "test",
    GOOGLE_CLIENT_SECRET: "test",
    WEBAUTHN_RP_ID: "localhost",
    WEBAUTHN_ORIGIN: "http://localhost:3000",
  };
  it("accepts local configuration", () =>
    expect(parseEnv(env).TRUSTED_PROXY_MODE).toBe("none"));
  it("requires HTTPS in production", () =>
    expect(() => parseEnv({ ...env, NODE_ENV: "production" })).toThrow(
      "HTTPS",
    ));
  it("requires a proxy secret for trusted Nginx headers", () =>
    expect(() => parseEnv({ ...env, TRUSTED_PROXY_MODE: "nginx" })).toThrow(
      "secret",
    ));
  it("requires matching WebAuthn origin", () =>
    expect(() => parseEnv({ ...env, WEBAUTHN_RP_ID: "other.test" })).toThrow(
      "match",
    ));
});
