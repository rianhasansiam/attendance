import { describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";

const base = {
  DATABASE_URL: "postgresql://test@localhost/attendance_test",
  AUTH_SECRET: "test-only-secret-at-least-32-characters",
  AUTH_URL: "http://localhost:3000",
  GOOGLE_CLIENT_ID: "test-client",
  GOOGLE_CLIENT_SECRET: "test-secret",
  WEBAUTHN_RP_ID: "localhost",
  WEBAUTHN_ORIGIN: "http://localhost:3000",
};

describe("SMTP environment validation", () => {
  it("keeps email optional for existing Google deployments", () => {
    const env = parseEnv(base);
    expect(env.SMTP_HOST).toBeUndefined();
    expect(env.SMTP_SECURE).toBe(false);
    expect(env.SMTP_PORT).toBe(587);
  });
  it("parses explicit false as false and accepts paired SMTP credentials", () => {
    const env = parseEnv({
      ...base,
      SMTP_HOST: "smtp.example.test",
      SMTP_PORT: "465",
      SMTP_SECURE: "false",
      SMTP_USER: "mail-account",
      SMTP_PASSWORD: "mail-secret",
      EMAIL_FROM: "attendance@example.test",
    });
    expect(env.SMTP_SECURE).toBe(false);
    expect(env.SMTP_PORT).toBe(465);
    expect(parseEnv({ ...base, SMTP_SECURE: "true" }).SMTP_SECURE).toBe(true);
  });
  it.each([
    { SMTP_USER: "mail-account" },
    { SMTP_PASSWORD: "mail-secret" },
    { SMTP_PORT: "0" },
    { SMTP_PORT: "65536" },
    { SMTP_SECURE: "yes" },
    { EMAIL_FROM: "untrusted\r\nBcc: other@example.test" },
  ])("rejects invalid or incomplete configuration", (config) => {
    expect(() => parseEnv({ ...base, ...config })).toThrow(
      "Invalid server configuration",
    );
  });
});
