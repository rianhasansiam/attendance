import { createHash, randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db } from "@/lib/db";
import { saveOwnPassword } from "@/modules/auth/password-management";
import {
  requestPasswordReset,
  resetPassword,
} from "@/modules/auth/password-reset";
import { verifyPassword } from "@/modules/auth/password";
import { limitPasswordAction } from "@/modules/auth/auth-rate-limit";

const mail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({ sendPasswordResetEmail: mail }));

const databaseUrl = process.env.TEST_DATABASE_URL;
const password = "a lengthy application passphrase";
const replacement = "a different lengthy app passphrase";
const proxySecret = "password-test-proxy-secret-at-least-32-characters";
const input = (value = password) => ({
  newPassword: value,
  confirmPassword: value,
});
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");

describe.skipIf(!databaseUrl)(
  "PostgreSQL application password lifecycle",
  () => {
    beforeAll(() => {
      if (!databaseUrl || !new URL(databaseUrl).pathname.includes("test"))
        throw new Error(
          "Password integration tests require a disposable test database",
        );
      Object.assign(process.env, {
        DATABASE_URL: databaseUrl,
        NODE_ENV: "test",
        AUTH_SECRET: "password-test-only-secret-at-least-32-characters",
        AUTH_URL: "http://localhost:3000",
        GOOGLE_CLIENT_ID: "test-client",
        GOOGLE_CLIENT_SECRET: "test-secret",
        WEBAUTHN_RP_ID: "localhost",
        WEBAUTHN_ORIGIN: "http://localhost:3000",
        TRUSTED_PROXY_MODE: "nginx",
        TRUSTED_PROXY_SECRET: proxySecret,
      });
    });
    beforeEach(() => mail.mockReset().mockResolvedValue(undefined));
    afterAll(async () => db.$disconnect());

    async function fixture() {
      const suffix = randomUUID();
      const user = await db.user.create({
        data: {
          email: `password-${suffix}@example.test`,
          role: "ADMIN",
          googleAccountId: suffix,
          accounts: {
            create: {
              type: "oauth",
              provider: "google",
              providerAccountId: suffix,
            },
          },
        },
      });
      const actor = await session(user.id);
      await session(user.id);
      return { user, actor };
    }
    async function session(id: string) {
      const row = await db.session.create({
        data: {
          userId: id,
          sessionToken: randomUUID(),
          expires: new Date(Date.now() + 3_600_000),
        },
      });
      return { id, sessionId: row.id };
    }
    async function issue(email: string) {
      await requestPasswordReset({ email });
      const delivery = [...mail.mock.calls]
        .reverse()
        .find(([recipient]) => recipient === email.trim().toLowerCase());
      expect(delivery).toBeDefined();
      return delivery![1] as string;
    }
    async function state(id: string) {
      return db.user.findUniqueOrThrow({
        where: { id },
        include: { accounts: true, sessions: true, passwordResetTokens: true },
      });
    }

    it("sets a Google-only user's password on the same identity and revokes every session", async () => {
      const { user, actor } = await fixture();
      expect(user.passwordHash).toBeNull();
      const result = await saveOwnPassword(actor, input());
      expect(result.signInRequired).toBe(true);
      expect(JSON.stringify(result)).not.toContain("hash");
      const saved = await state(user.id);
      expect(await verifyPassword(saved.passwordHash, password)).toBe(true);
      expect(saved.passwordHash).toMatch(/^\$argon2id\$/);
      expect(saved.accounts).toHaveLength(1);
      expect(saved.accounts[0].providerAccountId).toBe(user.googleAccountId);
      expect(saved.sessions).toHaveLength(0);
      expect(await db.user.count({ where: { email: user.email } })).toBe(1);
      const audit = await db.auditLog.findMany({
        where: { resourceId: user.id },
      });
      expect(audit.map((event) => event.action)).toContain("PASSWORD_SET");
      expect(JSON.stringify(audit)).not.toContain(password);
      expect(JSON.stringify(audit)).not.toContain(saved.passwordHash!);
    });

    it("requires the current application password and rotates it with token/session revocation", async () => {
      const { user, actor } = await fixture();
      await saveOwnPassword(actor, input());
      const nextActor = await session(user.id);
      const token = await issue(user.email);
      for (const currentPassword of [undefined, "wrong current password"])
        await expect(
          saveOwnPassword(nextActor, {
            ...input(replacement),
            currentPassword,
          }),
        ).rejects.toMatchObject({ code: "INVALID_CURRENT_PASSWORD" });
      expect((await state(user.id)).sessions).toHaveLength(1);
      await saveOwnPassword(nextActor, {
        ...input(replacement),
        currentPassword: password,
      });
      const saved = await state(user.id);
      expect(await verifyPassword(saved.passwordHash, replacement)).toBe(true);
      expect(await verifyPassword(saved.passwordHash, password)).toBe(false);
      expect(saved.sessions).toHaveLength(0);
      expect(saved.passwordResetTokens.every((row) => row.usedAt)).toBe(true);
      await expect(resetPassword({ ...input(), token })).rejects.toMatchObject({
        code: "INVALID_RESET_TOKEN",
      });
    });

    it("rejects arbitrary account IDs and revoked sessions before changing a password", async () => {
      const { user, actor } = await fixture();
      const other = await fixture();
      await expect(
        saveOwnPassword(actor, { ...input(), userId: other.user.id }),
      ).rejects.toThrow();
      await db.session.deleteMany({ where: { userId: user.id } });
      await expect(saveOwnPassword(actor, input())).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });
      expect((await state(user.id)).passwordHash).toBeNull();
      expect((await state(other.user.id)).passwordHash).toBeNull();
    });

    it("stores only a random token digest, binds the email, and expires it in 30 minutes", async () => {
      const { user } = await fixture();
      const before = Date.now();
      const token = await issue(`  ${user.email.toUpperCase()} `);
      const row = await db.passwordResetToken.findUniqueOrThrow({
        where: { tokenHash: digest(token) },
      });
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect(row.email).toBe(user.email);
      expect(row.tokenHash).not.toBe(token);
      expect(JSON.stringify(row)).not.toContain(token);
      expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + 30 * 60 * 1000,
      );
      expect(row.expiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + 30 * 60 * 1000,
      );
    });

    it("does not send for unknown, inactive, suspended, or profile-less employee accounts", async () => {
      await expect(
        requestPasswordReset({ email: `unknown-${randomUUID()}@example.test` }),
      ).resolves.toBeUndefined();
      const { user } = await fixture();
      for (const status of ["INACTIVE", "SUSPENDED"] as const) {
        await db.user.update({ where: { id: user.id }, data: { status } });
        await expect(
          requestPasswordReset({ email: user.email }),
        ).resolves.toBeUndefined();
      }
      await db.user.update({
        where: { id: user.id },
        data: { status: "ACTIVE", role: "EMPLOYEE" },
      });
      await requestPasswordReset({ email: user.email });
      expect(mail).not.toHaveBeenCalled();
      expect((await state(user.id)).passwordResetTokens).toHaveLength(0);
    });

    it("replaces previous tokens, verifies mailbox ownership and preserves Google linking", async () => {
      const { user } = await fixture();
      const oldToken = await issue(user.email);
      const token = await issue(user.email);
      expect(token).not.toBe(oldToken);
      await expect(
        resetPassword({ ...input(), token: oldToken }),
      ).rejects.toMatchObject({ code: "INVALID_RESET_TOKEN" });
      const result = await resetPassword({ ...input(), token });
      expect(result.signInRequired).toBe(true);
      const saved = await state(user.id);
      expect(await verifyPassword(saved.passwordHash, password)).toBe(true);
      expect(saved.emailVerified).toBeInstanceOf(Date);
      expect(saved.googleAccountId).toBe(user.googleAccountId);
      expect(saved.accounts).toHaveLength(1);
      expect(saved.sessions).toHaveLength(0);
      expect(saved.passwordResetTokens.every((row) => row.usedAt)).toBe(true);
      await expect(
        resetPassword({ ...input(replacement), token }),
      ).rejects.toMatchObject({ code: "INVALID_RESET_TOKEN" });
    });

    it("rejects expired, invalid, disabled-account and changed-email reset attempts", async () => {
      await expect(
        resetPassword({ ...input(), token: "a".repeat(64) }),
      ).rejects.toMatchObject({ code: "INVALID_RESET_TOKEN" });
      const { user } = await fixture();
      const expired = await issue(user.email);
      await db.passwordResetToken.update({
        where: { tokenHash: digest(expired) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await expect(
        resetPassword({ ...input(), token: expired }),
      ).rejects.toMatchObject({ code: "INVALID_RESET_TOKEN" });
      const disabled = await issue(user.email);
      await db.user.update({
        where: { id: user.id },
        data: { status: "SUSPENDED" },
      });
      await expect(
        resetPassword({ ...input(), token: disabled }),
      ).rejects.toMatchObject({ code: "INVALID_RESET_TOKEN" });
      await db.user.update({
        where: { id: user.id },
        data: { status: "ACTIVE" },
      });
      const changedEmail = await issue(user.email);
      await db.user.update({
        where: { id: user.id },
        data: { email: `changed-${randomUUID()}@example.test` },
      });
      await expect(
        resetPassword({ ...input(), token: changedEmail }),
      ).rejects.toMatchObject({ code: "INVALID_RESET_TOKEN" });
      expect((await state(user.id)).passwordHash).toBeNull();
    });

    it("allows exactly one concurrent reset to consume the same token", async () => {
      const { user } = await fixture();
      const token = await issue(user.email);
      const results = await Promise.allSettled([
        resetPassword({ ...input(), token }),
        resetPassword({ ...input(replacement), token }),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect(
        await db.auditLog.count({
          where: { action: "PASSWORD_RESET", resourceId: user.id },
        }),
      ).toBe(1);
      expect((await state(user.id)).sessions).toHaveLength(0);
    });

    it("serializes a reset racing an authenticated password set", async () => {
      const { user, actor } = await fixture();
      const token = await issue(user.email);
      const results = await Promise.allSettled([
        saveOwnPassword(actor, input()),
        resetPassword({ ...input(replacement), token }),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect((await state(user.id)).sessions).toHaveLength(0);
      expect(
        await db.auditLog.count({
          where: {
            action: { in: ["PASSWORD_SET", "PASSWORD_RESET"] },
            resourceId: user.id,
          },
        }),
      ).toBe(1);
    });

    it("keeps at most one live token during concurrent forgot requests", async () => {
      const { user } = await fixture();
      await Promise.all([
        requestPasswordReset({ email: user.email }),
        requestPasswordReset({ email: user.email }),
      ]);
      expect(
        await db.passwordResetToken.count({
          where: { userId: user.id, usedAt: null },
        }),
      ).toBe(1);
    });

    it("invalidates undeliverable tokens and never logs SMTP payloads", async () => {
      const { user } = await fixture();
      mail.mockRejectedValueOnce(
        new Error(`SMTP secret for ${user.email}: private-token`),
      );
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await requestPasswordReset({ email: user.email });
        expect(
          (await state(user.id)).passwordResetTokens.every((row) => row.usedAt),
        ).toBe(true);
        expect(JSON.stringify(log.mock.calls)).not.toContain(user.email);
        expect(JSON.stringify(log.mock.calls)).not.toContain("private-token");
        expect(log).toHaveBeenCalledWith(
          "Password reset email delivery failed",
        );
      } finally {
        log.mockRestore();
      }
    });

    it("enforces the reset identifier throttle through persisted database counters", async () => {
      const address = `2001:db8:${randomUUID().replaceAll("-", "").slice(0, 24).match(/.{4}/g)!.join(":")}`;
      const request = new Request("http://localhost:3000/api/password/reset", {
        headers: {
          "x-real-ip": address,
          "x-attendance-proxy-secret": proxySecret,
        },
      });
      const identifier = randomUUID();
      for (let i = 0; i < 5; i++)
        await limitPasswordAction(request, "reset", identifier);
      await expect(
        limitPasswordAction(request, "reset", identifier),
      ).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
    });
  },
);
