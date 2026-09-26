import type { Role } from "@prisma/client";
import { isEmployeeRole } from "./authorization";

/** Shared eligibility for every authentication method; roles remain database-owned. */
export function isAccountEligible(
  user: { status: string; role: Role; employee?: unknown } | null,
): boolean {
  return (
    !!user &&
    user.status === "ACTIVE" &&
    (!isEmployeeRole(user.role) || !!user.employee)
  );
}

export function hasLoginIdentity(user: {
  googleAccountId: string | null;
  passwordHash?: string | null;
  hasPassword?: boolean;
}): boolean {
  return !!(user.googleAccountId || user.passwordHash || user.hasPassword);
}
