import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/modules/auth/password";
import {
  credentialsSchema,
  passwordChangeSchema,
  resetPasswordSchema,
} from "@/modules/auth/password-validation";
import { auditSnapshot } from "@/modules/audit/service";
import { auditDisplaySnapshot } from "@/modules/audit/display";

describe("application password hashing and validation", () => {
  it("uses salted Argon2id and rejects incorrect, absent and malformed hashes", async () => {
    const value = "correct horse battery staple";
    const first = await hashPassword(value);
    const second = await hashPassword(value);
    expect(first).toMatch(/^\$argon2id\$v=19\$m=65536,p=1,t=3\$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain(value);
    expect(await verifyPassword(first, value)).toBe(true);
    expect(await verifyPassword(first, "wrong password")).toBe(false);
    expect(await verifyPassword(null, value)).toBe(false);
    expect(await verifyPassword("bad-hash", value)).toBe(false);
  });
  it("allows long passphrases without composition rules and never truncates or trims passwords", async () => {
    const value = " a long plain passphrase ";
    const encoded = await hashPassword(value);
    expect(await verifyPassword(encoded, value)).toBe(true);
    expect(await verifyPassword(encoded, value.trim())).toBe(false);
    await expect(hashPassword("a".repeat(129))).rejects.toThrow();
    await expect(hashPassword("short")).rejects.toThrow();
    expect(await verifyPassword(encoded, "a".repeat(129))).toBe(false);
    expect(
      credentialsSchema.parse({ email: " User@Example.com ", password: value }),
    ).toEqual({ email: "user@example.com", password: value });
  });
  it("validates confirmation, reset token and unknown management fields", () => {
    expect(
      passwordChangeSchema.safeParse({
        newPassword: "twelvecharacters",
        confirmPassword: "different",
      }).success,
    ).toBe(false);
    expect(
      passwordChangeSchema.safeParse({
        userId: "another-user",
        newPassword: "twelvecharacters",
        confirmPassword: "twelvecharacters",
      }).success,
    ).toBe(false);
    expect(
      resetPasswordSchema.safeParse({
        token: "bad",
        newPassword: "twelvecharacters",
        confirmPassword: "twelvecharacters",
      }).success,
    ).toBe(false);
  });
  it("redacts secrets recursively from stored and displayed audit snapshots", () => {
    const secrets = {
      passwordHash: "hash",
      tokenHash: "hash",
      resetToken: "token",
      newPassword: "new",
      currentPassword: "old",
      confirmPassword: "new",
      password: "plain",
      token: "raw",
    };
    const input = { nested: [secrets] };
    const expected = {
      nested: [
        Object.fromEntries(
          Object.keys(secrets).map((key) => [key, "[redacted]"]),
        ),
      ],
    };
    expect(auditSnapshot(input)).toEqual(expected);
    expect(auditDisplaySnapshot(input)).toEqual(expected);
  });
});
