import { DomainError } from "@/lib/errors";
export type Role = "EMPLOYEE" | "ADMIN" | "SUPER_ADMIN";
export type AuthorizedRecord = {
  email: string;
  status: string;
  role: Role;
  googleAccountId: string | null;
};
export type GoogleIdentity = {
  email?: unknown;
  email_verified?: unknown;
  sub?: unknown;
  hd?: unknown;
};
export function authorizeGoogle(
  identity: GoogleIdentity,
  user: AuthorizedRecord | null,
  domain?: string,
): void {
  if (
    typeof identity.email !== "string" ||
    identity.email_verified !== true ||
    typeof identity.sub !== "string" ||
    !identity.sub
  )
    throw new DomainError(
      "USER_NOT_AUTHORIZED",
      "A verified Google account is required.",
      403,
    );
  const email = identity.email.trim().toLowerCase();
  if (!user || user.email !== email)
    throw new DomainError(
      "USER_NOT_AUTHORIZED",
      "Your account has not been authorized by an administrator.",
      403,
    );
  if (user.status !== "ACTIVE")
    throw new DomainError("USER_INACTIVE", "Your account is not active.", 403);
  if (
    domain &&
    (email.split("@")[1] !== domain.toLowerCase() ||
      identity.hd !== domain.toLowerCase())
  )
    throw new DomainError(
      "WRONG_DOMAIN",
      "Use your authorized company Google account.",
      403,
    );
  if (user.googleAccountId && user.googleAccountId !== identity.sub)
    throw new DomainError(
      "USER_NOT_AUTHORIZED",
      "This Google account does not match your authorized identity.",
      403,
    );
}
export function authorizeRole(actual: Role, required: Role): void {
  const ranks = { EMPLOYEE: 0, ADMIN: 1, SUPER_ADMIN: 2 };
  if (ranks[actual] < ranks[required])
    throw new DomainError(
      "FORBIDDEN",
      "You do not have access to this resource.",
      403,
    );
}
