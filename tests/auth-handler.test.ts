import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { decode } from "next-auth/jwt";

const mocks = vi.hoisted(() => {
  const user = {
    id: "existing-user",
    email: "staff@example.com",
    name: "Staff",
    image: null,
    role: "EMPLOYEE",
    status: "ACTIVE",
    employee: { id: "existing-employee" },
    googleAccountId: "google-identity",
    passwordHash: "server-password-hash",
  };
  const db = {
    user: { findUnique: vi.fn(), updateMany: vi.fn() },
    session: { create: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return {
    user,
    db,
    authorizeCredentials: vi.fn(),
    env: {
      NODE_ENV: "test",
      AUTH_SECRET: "handler-test-secret-that-is-at-least-thirty-two-characters",
      AUTH_URL: "http://localhost:3000",
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
    },
  };
});

vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/env", () => ({ getEnv: () => mocks.env }));
vi.mock("@/modules/auth/credentials", () => ({
  authorizeCredentials: mocks.authorizeCredentials,
}));

import { handlers } from "@/auth";

function request(
  path: string,
  init?: ConstructorParameters<typeof NextRequest>[1],
) {
  return new NextRequest(`${mocks.env.AUTH_URL}/api/auth/${path}`, init);
}

function cookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

async function csrf() {
  const response = await handlers.GET(request("csrf"));
  expect(response.status).toBe(200);
  const body = await response.json();
  return { csrfToken: body.csrfToken as string, cookie: cookies(response) };
}

async function login() {
  const protection = await csrf();
  const response = await handlers.POST(
    request("callback/credentials", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: protection.cookie,
      },
      body: new URLSearchParams({
        csrfToken: protection.csrfToken,
        email: mocks.user.email,
        password: "application passphrase",
        callbackUrl: `${mocks.env.AUTH_URL}/employee/dashboard`,
      }),
    }),
  );
  return {
    response,
    cookie: `${protection.cookie}; ${cookies(response)}`,
    csrfToken: protection.csrfToken,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.user.findUnique.mockResolvedValue(mocks.user);
  mocks.db.session.create.mockResolvedValue({ id: "registry-session" });
  mocks.db.session.findFirst.mockResolvedValue({
    id: "registry-session",
    expires: new Date(Date.now() + 60_000),
  });
  mocks.db.$transaction.mockImplementation(
    async (callback: (tx: typeof mocks.db) => Promise<unknown>) =>
      callback(mocks.db),
  );
  const { id, email, name, image } = mocks.user;
  mocks.authorizeCredentials.mockResolvedValue({
    user: { id, email, name, image },
    proof: { email, passwordHash: mocks.user.passwordHash },
  });
});

describe("installed Auth.js HTTP authentication flow", () => {
  it("keeps both Google and credentials registered", async () => {
    const response = await handlers.GET(request("providers"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      google: { type: "oidc" },
      credentials: { type: "credentials" },
    });
  });

  it("requires Auth.js CSRF verification before credential authorization", async () => {
    const response = await handlers.POST(
      request("callback/credentials", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          email: mocks.user.email,
          password: "application passphrase",
        }),
      }),
    );
    expect(response.headers.get("location")).toContain("MissingCSRF");
    expect(mocks.authorizeCredentials).not.toHaveBeenCalled();
    expect(mocks.db.session.create).not.toHaveBeenCalled();
  });

  it("lets Auth.js issue an encrypted cookie, resolves the existing user, and revokes it on logout", async () => {
    const signedIn = await login();
    expect(signedIn.response.status).toBe(302);
    expect(signedIn.response.headers.get("location")).toBe(
      `${mocks.env.AUTH_URL}/employee/dashboard`,
    );
    const sessionCookie = signedIn.response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("authjs.session-token="));
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=Lax");
    const value = sessionCookie!
      .split(";", 1)[0]
      .slice("authjs.session-token=".length);
    expect(value).not.toBe("registry-session");
    const token = await decode({
      token: value,
      secret: mocks.env.AUTH_SECRET,
      salt: "authjs.session-token",
    });
    expect(token).toMatchObject({
      sub: mocks.user.id,
      sessionId: "registry-session",
    });
    expect(JSON.stringify(token)).not.toMatch(
      /password|role|google|passphrase/,
    );
    expect(mocks.db.session.create).toHaveBeenCalledTimes(1);

    const response = await handlers.GET(
      request("session", { headers: { cookie: signedIn.cookie } }),
    );
    expect(response.status).toBe(200);
    const session = await response.json();
    expect(session).toMatchObject({
      sessionId: "registry-session",
      user: { id: mocks.user.id, role: "EMPLOYEE", email: mocks.user.email },
    });
    expect(JSON.stringify(session)).not.toMatch(
      /password|google-identity|sessionToken|employee/,
    );

    const signedOut = await handlers.POST(
      request("signout", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: signedIn.cookie,
        },
        body: new URLSearchParams({ csrfToken: signedIn.csrfToken }),
      }),
    );
    expect(signedOut.status).toBe(302);
    expect(mocks.db.session.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: "registry-session", userId: mocks.user.id },
    });
    expect(cookies(signedOut)).toContain("authjs.session-token=");
  });

  it("returns the same public failure for all rejected credentials and creates no session", async () => {
    mocks.authorizeCredentials.mockResolvedValue(null);
    const { response } = await login();
    expect(response.headers.get("location")).toContain(
      "error=CredentialsSignin",
    );
    expect(response.headers.get("location")).toContain("code=credentials");
    expect(mocks.db.session.create).not.toHaveBeenCalled();
  });

  it("rejects a deleted session registry entry even while its Auth.js JWT is valid", async () => {
    const signedIn = await login();
    mocks.db.session.findFirst.mockResolvedValue(null);
    const response = await handlers.GET(
      request("session", { headers: { cookie: signedIn.cookie } }),
    );
    expect(await response.json()).toBeNull();
    expect(cookies(response)).toContain("authjs.session-token=");
    expect(mocks.db.session.create).toHaveBeenCalledTimes(1);
  });
});
