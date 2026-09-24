import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { authorizeRole, type Role } from "@/modules/auth/authorization";

export async function requireUser() {
  const session = await auth();
  if (!session?.user?.id || !session.sessionId)
    throw new DomainError(
      "UNAUTHENTICATED",
      "Please sign in with Google.",
      401,
    );
  const persistedSession = await db.session.findFirst({
    where: {
      id: session.sessionId,
      userId: session.user.id,
      expires: { gt: new Date() },
    },
    select: { id: true, expires: true },
  });
  if (!persistedSession)
    throw new DomainError(
      "UNAUTHENTICATED",
      "Your session has expired. Please sign in again.",
      401,
    );
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    include: { employee: true },
  });
  if (!user)
    throw new DomainError(
      "USER_NOT_AUTHORIZED",
      "Your account is not authorized.",
      403,
    );
  if (user.status !== "ACTIVE")
    throw new DomainError("USER_INACTIVE", "Your account is not active.", 403);
  if (!user.googleAccountId)
    throw new DomainError(
      "USER_NOT_AUTHORIZED",
      "Google authentication is required.",
      403,
    );
  return {
    ...user,
    sessionId: session.sessionId,
    sessionExpires: persistedSession.expires.toISOString(),
  };
}
export async function requireEmployee() {
  const user = await requireUser();
  if (!user.employee)
    throw new DomainError(
      "NO_EMPLOYEE",
      "An employee profile is required.",
      403,
    );
  return { ...user, employee: user.employee };
}
export async function requireAdmin() {
  const user = await requireUser();
  authorizeRole(user.role, "ADMIN");
  return user;
}
export async function requireDriveCostManager() {
  const user = await requireUser();
  authorizeRole(user.role, "MANAGE_DRIVER");
  return user;
}
export async function requireSuperAdmin() {
  const user = await requireUser();
  authorizeRole(user.role, "SUPER_ADMIN");
  return user;
}
export async function requirePageUser(role: Role = "EMPLOYEE") {
  try {
    const user = await requireUser();
    authorizeRole(user.role, role);
    return user;
  } catch (error) {
    if (error instanceof DomainError)
      redirect(error.status === 401 ? "/login" : "/forbidden");
    throw error;
  }
}
export async function requirePageEmployee() {
  try {
    return await requireEmployee();
  } catch (error) {
    if (error instanceof DomainError)
      redirect(error.status === 401 ? "/login" : "/forbidden");
    throw error;
  }
}
