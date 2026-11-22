import { DomainError } from "@/lib/errors";
import type {
  OfficeWorkActor,
  OfficeWorkPermissions,
  OfficeWorkStatus,
} from "./contracts";

export function canAccessOfficeWork(role: string): boolean {
  return (
    role === "SUPER_ADMIN" || role === "MANAGE_DRIVER" || role === "EMPLOYEE"
  );
}
export function canCreateOfficeWork(role: string): boolean {
  return role === "SUPER_ADMIN" || role === "MANAGE_DRIVER";
}
export function authorizeOfficeWork(actor: OfficeWorkActor): void {
  if (
    !actor.id ||
    !canAccessOfficeWork(actor.role) ||
    (actor.status !== undefined && actor.status !== "ACTIVE")
  )
    throw new DomainError(
      "FORBIDDEN",
      "You do not have access to Office Work.",
      403,
    );
}
export function canAssignOfficeWorkRole(
  actorRole: string,
  assigneeRole: string,
): boolean {
  return actorRole === "SUPER_ADMIN"
    ? assigneeRole === "EMPLOYEE" || assigneeRole === "MANAGE_DRIVER"
    : actorRole === "MANAGE_DRIVER" && assigneeRole === "EMPLOYEE";
}
export type OfficeWorkPermissionTask = {
  assigneeId: string | null;
  createdById: string | null;
  status: OfficeWorkStatus;
  archivedAt: Date | string | null;
  assignee: { role: string } | null;
};
export function mayManageOfficeWork(
  actor: OfficeWorkActor,
  task: OfficeWorkPermissionTask,
): boolean {
  return (
    actor.role === "SUPER_ADMIN" ||
    (actor.role === "MANAGE_DRIVER" &&
      task.createdById === actor.id &&
      task.assignee?.role === "EMPLOYEE")
  );
}
/** One policy powers server queries and every object-level authorization. */
export function visibilityWhere(actor: OfficeWorkActor): {
  assigneeId?: string;
} {
  authorizeOfficeWork(actor);
  return actor.role === "EMPLOYEE" ? { assigneeId: actor.id } : {};
}
export function taskPermissions(
  actor: OfficeWorkActor,
  task: OfficeWorkPermissionTask,
): OfficeWorkPermissions {
  authorizeOfficeWork(actor);
  const visible = actor.role !== "EMPLOYEE" || task.assigneeId === actor.id;
  const writable = visible && !task.archivedAt;
  const management = writable && mayManageOfficeWork(actor, task);
  const work =
    writable && (task.assigneeId === actor.id || actor.role === "SUPER_ADMIN");
  return {
    canEdit: management,
    canReassign: management,
    canStart: work && task.status === "PENDING",
    canComplete: work && task.status === "PROCESSING",
    canReopen: management && task.status === "DONE",
    canArchive: writable && actor.role === "SUPER_ADMIN",
    canAddUpdate: writable && task.assigneeId === actor.id,
    requiresOverrideReason:
      writable && actor.role === "SUPER_ADMIN" && task.assigneeId !== actor.id,
  };
}
