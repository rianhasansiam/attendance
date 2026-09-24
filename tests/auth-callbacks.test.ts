import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextAuthConfig } from "next-auth";

const mocks = vi.hoisted(() => {
  const db = {
    user: { findUnique: vi.fn(), updateMany: vi.fn() },
    account: { create: vi.fn() },
    session: { create: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return {
    db,
    factory: undefined as (() => NextAuthConfig) | undefined,
    auth: vi.fn(),
    env: {
      NODE_ENV: "production",
      AUTH_SECRET: "test-secret",
      AUTH_URL: "https://attendance.example.com",
      GOOGLE_CLIENT_ID: "test",
      GOOGLE_CLIENT_SECRET: "test",
      ALLOWED_GOOGLE_DOMAIN: undefined as string | undefined,
    },
  };
});
vi.mock("next-auth", () => ({
  default: (factory: () => NextAuthConfig) => {
    mocks.factory = factory;
    return {
      handlers: {},
      auth: mocks.auth,
      signIn: vi.fn(),
      signOut: vi.fn(),
    };
  },
}));
vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }));
vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/env", () => ({ getEnv: () => mocks.env }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
import "../src/auth";
import {
  requireAdmin,
  requireDriveCostManager,
  requireEmployee,
  requireUser,
} from "../src/lib/auth";

type SignInInput = Parameters<
  NonNullable<NonNullable<NextAuthConfig["callbacks"]>["signIn"]>
>[0];
type SessionInput = Parameters<
  NonNullable<NonNullable<NextAuthConfig["callbacks"]>["session"]>
>[0];
const user = {
  id: "employee-user",
  email: "staff@example.com",
  emailVerified: null,
  name: "Staff",
  image: null,
  status: "ACTIVE",
  role: "EMPLOYEE",
  googleAccountId: "google-subject",
  employee: { id: "employee-id" },
};
const signInInput = {
  user,
  account: {
    provider: "google",
    providerAccountId: "google-subject",
    type: "oidc",
  },
  profile: {
    email: user.email,
    email_verified: true,
    sub: "google-subject",
    hd: "example.com",
    picture: "https://example.com/avatar.png",
  },
} as SignInInput;
const rawSession = {
  user,
  userId: user.id,
  sessionToken: "private-session-token",
  expires: new Date(Date.now() + 60_000),
  unexpectedSecret: "must-not-leak",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.ALLOWED_GOOGLE_DOMAIN = undefined;
  mocks.db.user.findUnique.mockResolvedValue(user);
  mocks.db.user.updateMany.mockResolvedValue({ count: 1 });
  mocks.db.session.findUnique.mockResolvedValue({ id: "session-id" });
  mocks.db.session.findFirst.mockResolvedValue({
    id: "session-id",
    expires: new Date("2030-01-01T00:00:00Z"),
  });
  mocks.db.auditLog.create.mockResolvedValue({});
  mocks.db.$transaction.mockImplementation(
    async (callback: (tx: typeof mocks.db) => Promise<unknown>) =>
      callback(mocks.db),
  );
  mocks.auth.mockResolvedValue({
    user: { id: user.id, role: "EMPLOYEE" },
    sessionId: "session-id",
  });
});

describe("actual Auth.js configuration callbacks and adapter", () => {
  it("configures Google only with seven-day database sessions and secure cookies", () => {
    const config = mocks.factory!();
    expect(config.providers).toHaveLength(1);
    expect(config.session).toMatchObject({
      strategy: "database",
      maxAge: 604800,
      updateAge: 3600,
    });
    expect(config.useSecureCookies).toBe(true);
  });
  it("cannot provision public accounts even when the adapter is called directly", async () => {
    await expect(
      mocks.factory!().adapter!.createUser!({
        email: "unknown@example.com",
        emailVerified: null,
        id: "unknown",
      }),
    ).rejects.toThrow("Public registration");
  });
  it("requires a verified, authorized identity before binding the subject", async () => {
    const config = mocks.factory!();
    expect(await config.callbacks!.signIn!(signInInput)).toBe(true);
    expect(mocks.db.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: user.id,
          email: user.email,
          status: "ACTIVE",
        }),
        data: expect.objectContaining({ googleAccountId: "google-subject" }),
      }),
    );
    mocks.db.user.findUnique.mockResolvedValue(null);
    expect(await config.callbacks!.signIn!(signInInput)).toBe(false);
    expect(mocks.db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "LOGIN_REJECTED" }),
      }),
    );
  });
  it("rejects unverified email, subject mismatch, wrong provider and missing employee profile", async () => {
    const signIn = mocks.factory!().callbacks!.signIn!;
    expect(
      await signIn({
        ...signInInput,
        profile: { ...signInInput.profile, email_verified: false },
      }),
    ).toBe(false);
    expect(
      await signIn({
        ...signInInput,
        account: { ...signInInput.account!, providerAccountId: "different" },
      }),
    ).toBe(false);
    expect(
      await signIn({
        ...signInInput,
        account: { ...signInInput.account!, provider: "credentials" },
      }),
    ).toBe(false);
    mocks.db.user.findUnique.mockResolvedValue({ ...user, employee: null });
    expect(await signIn(signInInput)).toBe(false);
  });
  it("rejects account changes between authorization lookup and subject binding", async () => {
    mocks.db.user.updateMany.mockResolvedValue({ count: 0 });
    expect(await mocks.factory!().callbacks!.signIn!(signInInput)).toBe(false);
  });
  it("requires an employee profile when signing in as MANAGE_DRIVER", async () => {
    const signIn = mocks.factory!().callbacks!.signIn!;
    mocks.db.user.findUnique.mockResolvedValue({
      ...user,
      role: "MANAGE_DRIVER",
    });
    expect(await signIn(signInInput)).toBe(true);
    mocks.db.user.findUnique.mockResolvedValue({
      ...user,
      role: "MANAGE_DRIVER",
      employee: null,
    });
    expect(await signIn(signInInput)).toBe(false);
  });
  it("discards OAuth access, refresh and ID tokens when linking an account", async () => {
    const config = mocks.factory!();
    await config.callbacks!.signIn!(signInInput);
    await config.adapter!.linkAccount!({
      userId: user.id,
      provider: "google",
      providerAccountId: "google-subject",
      type: "oidc",
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      id_token: "id-secret",
    });
    expect(mocks.db.account.create).toHaveBeenCalledExactlyOnceWith({
      data: {
        userId: user.id,
        provider: "google",
        providerAccountId: "google-subject",
        type: "oidc",
      },
    });
  });
  it("does not create sessions unless the same request authorized the same identity", async () => {
    const config = mocks.factory!();
    const session = {
      userId: user.id,
      sessionToken: "token",
      expires: new Date(Date.now() + 60_000),
    };
    await expect(config.adapter!.createSession!(session)).rejects.toThrow(
      "Unauthorized",
    );
    await config.callbacks!.signIn!(signInInput);
    mocks.db.user.findUnique.mockResolvedValue({ ...user, status: "INACTIVE" });
    await expect(config.adapter!.createSession!(session)).rejects.toThrow(
      "Unauthorized",
    );
    expect(mocks.db.session.create).not.toHaveBeenCalled();
    mocks.db.user.findUnique.mockResolvedValue(user);
    await config.adapter!.createSession!(session);
    expect(mocks.db.$queryRaw).toHaveBeenCalled();
    expect(mocks.db.session.create).toHaveBeenCalledExactlyOnceWith({
      data: session,
    });
  });
  it("returns only safe public session fields; never returns a bearer token", async () => {
    const session = await mocks.factory!().callbacks!.session!({
      session: rawSession,
      user,
    } as unknown as SessionInput);
    expect(session).toEqual({
      expires: rawSession.expires.toISOString(),
      sessionId: "session-id",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        role: user.role,
      },
    });
    expect(JSON.stringify(session)).not.toMatch(
      /private-session-token|must-not-leak|google-subject/,
    );
  });
  it("invalidates public session output after account deactivation, identity reset or session deletion", async () => {
    const callback = mocks.factory!().callbacks!.session!;
    for (const changed of [
      { ...user, status: "SUSPENDED" },
      { ...user, googleAccountId: null },
    ]) {
      mocks.db.user.findUnique.mockResolvedValue(changed);
      const result = await callback({
        session: rawSession,
        user,
      } as unknown as SessionInput);
      expect(result.user?.id).toBe("");
      expect(
        "sessionId" in result ? result.sessionId : undefined,
      ).toBeUndefined();
    }
    mocks.db.user.findUnique.mockResolvedValue(user);
    mocks.db.session.findUnique.mockResolvedValue(null);
    expect(
      (await callback({ session: rawSession, user } as unknown as SessionInput))
        .user?.id,
    ).toBe("");
  });
  it("redirects only to the canonical origin", async () => {
    const redirect = mocks.factory!().callbacks!.redirect!;
    expect(
      await redirect({
        url: "https://attacker.example/path",
        baseUrl: mocks.env.AUTH_URL,
      }),
    ).toBe(`${mocks.env.AUTH_URL}/`);
    expect(
      await redirect({
        url: "/employee/dashboard",
        baseUrl: mocks.env.AUTH_URL,
      }),
    ).toBe(`${mocks.env.AUTH_URL}/employee/dashboard`);
    expect(
      await redirect({
        url: "https://user:password@attendance.example.com/",
        baseUrl: mocks.env.AUTH_URL,
      }),
    ).toBe(`${mocks.env.AUTH_URL}/`);
  });
});

describe("backend session and role guards", () => {
  it("allows MANAGE_DRIVER employee and drive-cost access, but denies administrator access", async () => {
    mocks.db.user.findUnique.mockResolvedValue({
      ...user,
      role: "MANAGE_DRIVER",
    });
    await expect(requireEmployee()).resolves.toMatchObject({
      employee: { id: "employee-id" },
    });
    await expect(requireDriveCostManager()).resolves.toMatchObject({
      role: "MANAGE_DRIVER",
    });
    await expect(requireAdmin()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("rechecks drive-cost permission after a role is removed", async () => {
    mocks.auth.mockResolvedValue({
      user: { id: user.id, role: "MANAGE_DRIVER" },
      sessionId: "session-id",
    });
    mocks.db.user.findUnique.mockResolvedValue({
      ...user,
      role: "MANAGE_DRIVER",
    });
    await expect(requireDriveCostManager()).resolves.toMatchObject({
      role: "MANAGE_DRIVER",
    });
    mocks.db.user.findUnique.mockResolvedValue(user);
    await expect(requireDriveCostManager()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
  it.each(["ADMIN", "SUPER_ADMIN"])(
    "retains drive-cost access for %s",
    async (role) => {
      mocks.db.user.findUnique.mockResolvedValue({ ...user, role });
      await expect(requireDriveCostManager()).resolves.toMatchObject({ role });
    },
  );
  it.each([
    ["account deactivation", "USER_INACTIVE"],
    ["identity reset", "USER_NOT_AUTHORIZED"],
    ["session revocation", "UNAUTHENTICATED"],
  ])(
    "rechecks %s after the same user was successfully authorized",
    async (change, code) => {
      await expect(requireUser()).resolves.toMatchObject({ id: user.id });
      if (change === "session revocation") {
        mocks.db.session.findFirst.mockResolvedValue(null);
      } else {
        mocks.db.user.findUnique.mockResolvedValue({
          ...user,
          ...(change === "account deactivation"
            ? { status: "INACTIVE" }
            : { googleAccountId: null }),
        });
      }
      // Auth.js still returns the previous identity; the guard must read current
      // database state instead of reusing its earlier successful authorization.
      await expect(requireUser()).rejects.toMatchObject({ code });
    },
  );
  it("rejects a demoted administrator on the next authorization check", async () => {
    mocks.auth.mockResolvedValue({
      user: { id: user.id, role: "ADMIN" },
      sessionId: "session-id",
    });
    mocks.db.user.findUnique.mockResolvedValue({ ...user, role: "ADMIN" });
    await expect(requireAdmin()).resolves.toMatchObject({ role: "ADMIN" });
    mocks.db.user.findUnique.mockResolvedValue(user);
    await expect(requireAdmin()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("requires a live persisted session even after Auth.js resolved an identity", async () => {
    mocks.db.session.findFirst.mockResolvedValue(null);
    await expect(requireUser()).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });
  it("rejects missing OAuth binding and inactive accounts", async () => {
    mocks.db.user.findUnique.mockResolvedValue({
      ...user,
      googleAccountId: null,
    });
    await expect(requireUser()).rejects.toMatchObject({
      code: "USER_NOT_AUTHORIZED",
    });
    mocks.db.user.findUnique.mockResolvedValue({ ...user, status: "INACTIVE" });
    await expect(requireUser()).rejects.toMatchObject({
      code: "USER_INACTIVE",
    });
  });
  it("rejects employee access to an admin route without trusting the session role", async () => {
    mocks.auth.mockResolvedValue({
      user: { id: user.id, role: "SUPER_ADMIN" },
      sessionId: "session-id",
    });
    await expect(requireAdmin()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("rejects attendance use without an employee profile", async () => {
    mocks.db.user.findUnique.mockResolvedValue({ ...user, employee: null });
    await expect(requireEmployee()).rejects.toMatchObject({
      code: "NO_EMPLOYEE",
    });
  });
});
