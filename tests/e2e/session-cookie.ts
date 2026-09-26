import { encode } from "next-auth/jwt";
import type { PrismaClient } from "@prisma/client";

// Test-only fixture. Real sign-ins run through Auth.js callbacks and CSRF checks.
export async function testSessionCookie(
  db: PrismaClient,
  sessionToken: string,
) {
  const row = await db.session.findUniqueOrThrow({ where: { sessionToken } });
  return encode({
    secret: "e2e-only-auth-secret-never-for-production-1234567890",
    salt: "authjs.session-token",
    token: { sub: row.userId, sessionId: row.id },
    maxAge: 3600,
  });
}
