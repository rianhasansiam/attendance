import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("starts password-free Google sign-in with the configured callback and OAuth protections", async () => {
    const discovery = vi.fn().mockResolvedValue(
      Response.json({
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
        jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      }),
    );
    vi.stubGlobal("fetch", discovery);
    const protection = await csrf();
    const response = await handlers.POST(
      request("signin/google", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: protection.cookie,
        },
        body: new URLSearchParams({ csrfToken: protection.csrfToken }),
      }),
    );

    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get("location")!);
    expect(redirect.origin).toBe("https://accounts.google.com");
    expect(redirect.searchParams.get("client_id")).toBe(
      mocks.env.GOOGLE_CLIENT_ID,
    );
    expect(redirect.searchParams.get("redirect_uri")).toBe(
      `${mocks.env.AUTH_URL}/api/auth/callback/google`,
    );
    expect(redirect.searchParams.get("scope")).toBe("openid email profile");
    expect(redirect.searchParams.get("prompt")).toBe("select_account");
    expect(redirect.searchParams.get("code_challenge_method")).toBe("S256");
    for (const check of ["state", "nonce", "code_challenge"]) {
      expect(redirect.searchParams.get(check)).toBeTruthy();
    }
    for (const name of ["state", "nonce", "pkce.code_verifier"]) {
      const cookie = response.headers
        .getSetCookie()
        .find((value) => value.startsWith(`authjs.${name}=`));
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
    }
    expect(mocks.authorizeCredentials).not.toHaveBeenCalled();
    expect(mocks.db.session.create).not.toHaveBeenCalled();
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
