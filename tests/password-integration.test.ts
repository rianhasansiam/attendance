import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { saveOwnPassword } from "@/modules/auth/password-management";
import { verifyPassword } from "@/modules/auth/password";
import { limitPasswordAction } from "@/modules/auth/auth-rate-limit";

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
      await db.passwordResetToken.create({
        data: {
          userId: user.id,
          email: user.email,
          tokenHash: digest(randomUUID()),
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });
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

    it("allows only one of two concurrent authenticated password saves", async () => {
      const { user, actor } = await fixture();
      const results = await Promise.allSettled([
        saveOwnPassword(actor, input()),
        saveOwnPassword(actor, input(replacement)),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      const saved = await state(user.id);
      expect(saved.sessions).toHaveLength(0);
      expect(
        await db.auditLog.count({
          where: { action: "PASSWORD_SET", resourceId: user.id },
        }),
      ).toBe(1);
      const validPasswords = await Promise.all([
        verifyPassword(saved.passwordHash, password),
        verifyPassword(saved.passwordHash, replacement),
      ]);
      expect(validPasswords.filter(Boolean)).toHaveLength(1);
    });

    it("enforces the password-management identifier throttle through persisted database counters", async () => {
      const address = `2001:db8:${randomUUID().replaceAll("-", "").slice(0, 24).match(/.{4}/g)!.join(":")}`;
      const request = new Request(
        "http://localhost:3000/api/account/password",
        {
          headers: {
            "x-real-ip": address,
            "x-attendance-proxy-secret": proxySecret,
          },
        },
      );
      const identifier = randomUUID();
      for (let i = 0; i < 5; i++)
        await limitPasswordAction(request, "manage", identifier);
      await expect(
        limitPasswordAction(request, "manage", identifier),
      ).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
    });
  },
);
