import "server-only";
import { randomUUID } from "node:crypto";
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import type { Adapter } from "next-auth/adapters";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { authorizeGoogle } from "@/modules/auth/authorization";
import {
  hasLoginIdentity,
  isAccountEligible,
} from "@/modules/auth/account-policy";
import { authorizeCredentials } from "@/modules/auth/credentials";

const SESSION_MAX_AGE = 7 * 24 * 60 * 60;
type AuthorizedIdentity =
  | { provider: "google"; userId: string; email: string; subject: string }
  | {
      provider: "credentials";
      userId: string;
      email: string;
      passwordHash: string;
    };

export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const env = getEnv();
  const base = PrismaAdapter(db);
  // This proof exists only during this request, never in callback user data,
  // JWT claims, persisted sessions, logs, or client responses.
  let authorizedIdentity: AuthorizedIdentity | undefined;
  const adapter: Adapter = {
    ...base,
    // Authorization never provisions users, even if provider callbacks change.
    createUser: async () => {
      throw new Error("Public registration is disabled");
    },
    linkAccount: async (account) => {
      if (account.provider !== "google")
        throw new Error("Unsupported identity provider");
      if (
        authorizedIdentity?.provider !== "google" ||
        authorizedIdentity.userId !== account.userId ||
        authorizedIdentity.subject !== account.providerAccountId
      )
        throw new Error("Unauthorized identity");
      const identity = authorizedIdentity;
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${account.userId} FOR UPDATE`;
        const user = await tx.user.findUnique({
          where: { id: account.userId },
          include: { employee: true },
        });
        if (
          !user ||
          !isAccountEligible(user) ||
          user.email !== identity.email ||
          user.googleAccountId !== account.providerAccountId
        )
          throw new Error("Unauthorized identity");
        // Google tokens are unnecessary after identity verification; do not persist them.
        await tx.account.create({
          data: {
            userId: user.id,
            type: account.type,
            provider: "google",
            providerAccountId: account.providerAccountId,
          },
        });
      });
    },
    createSession: async () => {
      // Both providers use Auth.js JWT sessions. Registry entries are created
      // only by its successful sign-in callback below, with a verified identity.
      throw new Error("Database bearer sessions are disabled");
    },
  };
  return {
    adapter,
    secret: env.AUTH_SECRET,
    trustHost: true, // AUTH_URL is canonical; Nginx accepts only the configured server_name.
    useSecureCookies: env.NODE_ENV === "production",
    session: {
      // Credentials in this Auth.js version requires JWT sessions. Auth.js
      // remains the sole cookie/JWT issuer for Google and password sign-in.
      strategy: "jwt",
      maxAge: SESSION_MAX_AGE,
    },
    providers: [
      Google({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        // Only verified Google email may link to an already-authorized local user.
        allowDangerousEmailAccountLinking: true,
        checks: ["pkce", "state", "nonce"],
        profile: (profile) => ({
          id: profile.sub,
          name: profile.name,
          email: profile.email?.trim().toLowerCase(),
          image: profile.picture,
        }),
        authorization: {
          params: { scope: "openid email profile", prompt: "select_account" },
        },
      }),
      Credentials({
        credentials: {
          email: { label: "Email", type: "email" },
          password: { label: "Application password", type: "password" },
        },
        async authorize(credentials, request) {
          authorizedIdentity = undefined;
          const verified = await authorizeCredentials(credentials, request);
          if (!verified) return null;
          authorizedIdentity = {
            provider: "credentials",
            userId: verified.user.id,
            ...verified.proof,
          };
          return verified.user;
        },
      }),
    ],
    pages: { signIn: "/login", error: "/login" },
    callbacks: {
      async signIn({ user: signingInUser, account, profile }) {
        if (account?.provider === "credentials") {
          return (
            authorizedIdentity?.provider === "credentials" &&
            authorizedIdentity.userId === signingInUser.id
          );
        }
        authorizedIdentity = undefined;
        if (
          account?.provider !== "google" ||
          !profile ||
          account.providerAccountId !== profile.sub
        )
          return false;
        const email =
          typeof profile.email === "string"
            ? profile.email.trim().toLowerCase()
            : "";
        const user = await db.user.findUnique({
          where: { email },
          include: { employee: true },
        });
        try {
          authorizeGoogle(profile, user, env.ALLOWED_GOOGLE_DOMAIN);
          if (!user || !isAccountEligible(user)) return false;
          const bound = await db.user.updateMany({
            where: {
              id: user.id,
              email,
              status: "ACTIVE",
              OR: [{ googleAccountId: null }, { googleAccountId: profile.sub }],
            },
            data: {
              googleAccountId: profile.sub,
              lastLoginAt: new Date(),
              emailVerified: new Date(),
              ...(typeof profile.picture === "string"
                ? { image: profile.picture }
                : {}),
            },
          });
          if (bound.count !== 1) return false;
          authorizedIdentity = {
            provider: "google",
            userId: user.id,
            email,
            subject: profile.sub!,
          };
          return true;
        } catch {
          await db.auditLog.create({
            data: {
              actorId: user?.id,
              action: "LOGIN_REJECTED",
              resource: "User",
              resourceId: user?.id,
            },
          });
          return false;
        }
      },
      async jwt({ token, user, account }) {
        if (account) {
          const identity = authorizedIdentity;
          authorizedIdentity = undefined;
          if (
            !identity ||
            identity.userId !== user.id ||
            identity.provider !== account.provider
          )
            return null;
          const row = await db.$transaction(async (tx) => {
            // Password changes and admin revocations lock this same user. A
            // password verified before a concurrent reset cannot create a session.
            await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${identity.userId} FOR UPDATE`;
            const current = await tx.user.findUnique({
              where: { id: identity.userId },
              include: { employee: true },
            });
            if (
              !current ||
              !isAccountEligible(current) ||
              current.email !== identity.email ||
              (identity.provider === "google"
                ? current.googleAccountId !== identity.subject
                : current.passwordHash !== identity.passwordHash)
            )
              return null;
            if (identity.provider === "credentials") {
              await tx.user.updateMany({
                where: { id: current.id },
                data: { lastLoginAt: new Date() },
              });
            }
            return tx.session.create({
              data: {
                userId: current.id,
                // Retain the existing Session table for revocation and passkey
                // challenge binding. This random value is never an auth cookie.
                sessionToken: randomUUID(),
                expires: new Date(Date.now() + SESSION_MAX_AGE * 1000),
              },
              select: { id: true },
            });
          });
          return row ? { sub: identity.userId, sessionId: row.id } : null;
        }
        if (!token.sub || !token.sessionId) return null;
        const row = await db.session.findFirst({
          where: {
            id: token.sessionId,
            userId: token.sub,
            expires: { gt: new Date() },
          },
          select: { id: true },
        });
        if (!row) return null;
        const current = await db.user.findUnique({
          where: { id: token.sub },
          include: { employee: true },
        });
        if (
          !current ||
          !isAccountEligible(current) ||
          !hasLoginIdentity(current)
        )
          return null;
        // Client session updates cannot overwrite identity, role, or registry ID.
        return { sub: current.id, sessionId: row.id };
      },
      async session({ session, token }) {
        const expires = String(session.expires);
        const denied = { expires, user: { id: "", role: "EMPLOYEE" as const } };
        if (!token.sub || !token.sessionId) return denied;
        const row = await db.session.findFirst({
          where: {
            id: token.sessionId,
            userId: token.sub,
            expires: { gt: new Date() },
          },
          select: { id: true, expires: true },
        });
        const current = await db.user.findUnique({
          where: { id: token.sub },
          include: { employee: true },
        });
        if (
          !row ||
          !current ||
          !isAccountEligible(current) ||
          !hasLoginIdentity(current)
        )
          return denied;
        // Explicit allowlist: no password hashes, provider subjects, DB bearer
        // tokens, or arbitrary adapter fields through /api/auth/session.
        return {
          expires: row.expires.toISOString(),
          sessionId: row.id,
          user: {
            id: current.id,
            role: current.role,
            name: current.name,
            email: current.email,
            image: current.image,
          },
        };
      },
      redirect({ url, baseUrl }) {
        const origin = new URL(env.AUTH_URL).origin;
        try {
          const target = new URL(url, baseUrl);
          return target.origin === origin &&
            !target.username &&
            !target.password
            ? target.href
            : `${origin}/`;
        } catch {
          return `${origin}/`;
        }
      },
    },
    events: {
      async signOut(message) {
        if (
          "token" in message &&
          message.token?.sub &&
          message.token.sessionId
        ) {
          await db.session.deleteMany({
            where: { id: message.token.sessionId, userId: message.token.sub },
          });
        }
      },
    },
    logger: {
      error: (error) =>
        console.error("Authentication failed", { type: error.name }),
      warn: (code) => console.warn("Authentication warning", { code }),
      debug: () => {},
    },
  };
});
