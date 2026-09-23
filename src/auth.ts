import "server-only";
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import type { Adapter } from "next-auth/adapters";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { authorizeGoogle, isEmployeeRole } from "@/modules/auth/authorization";

export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const env = getEnv();
  const base = PrismaAdapter(db);
  let authorizedIdentity:
    { userId: string; email: string; subject: string } | undefined;
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
        !authorizedIdentity ||
        authorizedIdentity.userId !== account.userId ||
        authorizedIdentity.subject !== account.providerAccountId
      )
        throw new Error("Unauthorized identity");
      const identity = authorizedIdentity;
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${account.userId} FOR UPDATE`;
        const user = await tx.user.findUnique({
          where: { id: account.userId },
        });
        if (
          !user ||
          user.status !== "ACTIVE" ||
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
    createSession: async (session) => {
      if (!authorizedIdentity || authorizedIdentity.userId !== session.userId)
        throw new Error("Unauthorized identity");
      const identity = authorizedIdentity;
      return db.$transaction(async (tx) => {
        // Admin revocation locks the same user before deleting sessions.
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${session.userId} FOR UPDATE`;
        const user = await tx.user.findUnique({
          where: { id: session.userId },
        });
        if (
          !user ||
          user.status !== "ACTIVE" ||
          user.email !== identity.email ||
          user.googleAccountId !== identity.subject
        )
          throw new Error("Unauthorized identity");
        return tx.session.create({
          data: {
            userId: user.id,
            sessionToken: session.sessionToken,
            expires: session.expires,
          },
        });
      });
    },
  };
  return {
    adapter,
    secret: env.AUTH_SECRET,
    trustHost: true, // AUTH_URL is canonical; Nginx accepts only the configured server_name.
    useSecureCookies: env.NODE_ENV === "production",
    session: {
      strategy: "database",
      maxAge: 7 * 24 * 60 * 60,
      updateAge: 60 * 60,
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
    ],
    pages: { signIn: "/login", error: "/login" },
    callbacks: {
      async signIn({ account, profile }) {
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
          if (!user || (isEmployeeRole(user.role) && !user.employee))
            return false;
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
      async session({ session, user }) {
        const current = await db.user.findUnique({ where: { id: user.id } });
        const expires = session.expires.toISOString();
        if (!current || current.status !== "ACTIVE" || !current.googleAccountId)
          return { expires, user: { id: "", role: "EMPLOYEE" as const } };
        const row = await db.session.findUnique({
          where: {
            sessionToken: session.sessionToken,
            userId: current.id,
            expires: { gt: new Date() },
          },
          select: { id: true },
        });
        if (!row)
          return { expires, user: { id: "", role: "EMPLOYEE" as const } };
        // Explicit allowlist: never send the DB sessionToken, provider subject,
        // account status, or adapter internals through /api/auth/session.
        return {
          expires,
          sessionId: row?.id,
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
    logger: {
      error: (error) =>
        console.error("Authentication failed", { type: error.name }),
      warn: (code) => console.warn("Authentication warning", { code }),
      debug: () => {},
    },
  };
});
