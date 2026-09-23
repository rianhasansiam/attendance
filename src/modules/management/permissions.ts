import type { Role, UserStatus } from "@prisma/client";
import { DomainError } from "@/lib/errors";
import { isEmployeeRole } from "@/modules/auth/authorization";

export type Actor = { id: string; role: Role };

export function assertMayManageUser(
  actor: Actor,
  target: { id: string; role: Role },
  next?: { role?: Role; status?: UserStatus },
) {
  if (actor.role !== "ADMIN" && actor.role !== "SUPER_ADMIN")
    throw new DomainError(
      "FORBIDDEN",
      "Administrator access is required.",
      403,
    );
  if (
    actor.role !== "SUPER_ADMIN" &&
    (!isEmployeeRole(target.role) || (next?.role && !isEmployeeRole(next.role)))
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "Only a super administrator may manage administrator accounts.",
      403,
    );
  }
  if (
    target.id === actor.id &&
    ((next?.role && next.role !== actor.role) ||
      (next?.status && next.status !== "ACTIVE"))
  ) {
    throw new DomainError(
      "SELF_ACCESS_CHANGE",
      "You cannot remove your own administrator access.",
      400,
    );
  }
}

export function assertSuperAdmin(actor: Actor) {
  if (actor.role !== "SUPER_ADMIN")
    throw new DomainError(
      "FORBIDDEN",
      "Super administrator access is required.",
      403,
    );
}
