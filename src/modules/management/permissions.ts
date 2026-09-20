import type { Role, UserStatus } from "@prisma/client";
import { DomainError } from "@/lib/errors";

export type Actor = { id: string; role: Role };

export function assertMayManageUser(
  actor: Actor,
  target: { id: string; role: Role },
  next?: { role?: Role; status?: UserStatus },
) {
  if (actor.role === "EMPLOYEE")
    throw new DomainError(
      "FORBIDDEN",
      "Administrator access is required.",
      403,
    );
  if (
    actor.role !== "SUPER_ADMIN" &&
    (target.role !== "EMPLOYEE" || (next?.role && next.role !== "EMPLOYEE"))
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
