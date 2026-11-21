import { DomainError } from "@/lib/errors";
import { todayInTimezone } from "@/modules/daily-expenses/contracts";
import type {
  OfficeWorkActionInput,
  OfficeWorkActor,
  OfficeWorkStatus,
} from "./contracts";
import { taskPermissions, type OfficeWorkPermissionTask } from "./permissions";

export { todayInTimezone };
export function officeWorkTimezone(): string {
  const timezone = (
    process.env.OFFICE_WORK_TIMEZONE ??
    process.env.DAILY_EXPENSES_TIMEZONE ??
    "Asia/Dhaka"
  ).trim();
  try {
    todayInTimezone(timezone);
  } catch {
    throw new Error("Invalid Office Work business timezone.");
  }
  return timezone;
}
export function isOfficeWorkOverdue(
  task: { archivedAt: unknown; status: string; dueDate: string | null },
  today: string,
): boolean {
  return (
    !task.archivedAt &&
    task.status !== "DONE" &&
    !!task.dueDate &&
    task.dueDate < today
  );
}
export function officeWorkConflict(): DomainError {
  return new DomainError(
    "TASK_CONFLICT",
    "This task changed. Refresh and review it before trying again.",
    409,
  );
}
type LifecycleTask = OfficeWorkPermissionTask & {
  startedAt: Date | null;
  completedAt: Date | null;
};
/** Returns lifecycle fields only; request schemas never accept timestamps or generic statuses. */
export function transitionPatch(
  actor: OfficeWorkActor,
  task: LifecycleTask,
  action: OfficeWorkActionInput,
  now: Date = new Date(),
): {
  status?: OfficeWorkStatus;
  startedAt?: Date | null;
  completedAt?: Date | null;
  archivedAt?: Date;
} {
  const permissions = taskPermissions(actor, task);
  if (task.archivedAt)
    throw new DomainError(
      "TASK_ARCHIVED",
      "Archived tasks are read-only.",
      409,
    );
  if (action.action === "start" || action.action === "complete") {
    if (actor.role !== "SUPER_ADMIN" && task.assigneeId !== actor.id)
      throw new DomainError(
        "FORBIDDEN",
        "Only the current assignee can change this task's work status.",
        403,
      );
    if (permissions.requiresOverrideReason && !action.reason?.trim())
      throw new DomainError(
        "OVERRIDE_REASON_REQUIRED",
        "Enter a reason for acting on the assignee's behalf.",
      );
    if (action.action === "start") {
      if (!permissions.canStart)
        throw new DomainError(
          "INVALID_TASK_TRANSITION",
          "Only pending tasks can be started.",
          409,
        );
      return { status: "PROCESSING", startedAt: task.startedAt ?? now };
    }
    if (!permissions.canComplete)
      throw new DomainError(
        "INVALID_TASK_TRANSITION",
        "Start work before marking this task as done.",
        409,
      );
    return { status: "DONE", completedAt: now };
  }
  if (action.action === "reopen") {
    if (!permissions.canEdit)
      throw new DomainError("FORBIDDEN", "You cannot reopen this task.", 403);
    if (!permissions.canReopen)
      throw new DomainError(
        "INVALID_TASK_TRANSITION",
        "Only completed tasks can be reopened.",
        409,
      );
    if (!action.reason?.trim())
      throw new DomainError(
        "REOPEN_REASON_REQUIRED",
        "Enter a reason for reopening.",
      );
    return { status: "PROCESSING", completedAt: null };
  }
  if (action.action === "archive") {
    if (!permissions.canArchive)
      throw new DomainError(
        "FORBIDDEN",
        "Only super administrators can archive tasks.",
        403,
      );
    return { archivedAt: now };
  }
  throw new DomainError(
    "INVALID_TASK_TRANSITION",
    "Use the assignment operation to reassign this task.",
  );
}
