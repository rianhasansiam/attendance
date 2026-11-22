import { DomainError } from "@/lib/errors";
import type { WorkReportActor, WorkReportPermissions } from "./contracts";

export function canAccessWorkReport(role: string): boolean {
  return (
    role === "SUPER_ADMIN" || role === "MANAGE_DRIVER" || role === "EMPLOYEE"
  );
}
export function authorizeWorkReport(actor: WorkReportActor): void {
  if (
    !actor.id ||
    !canAccessWorkReport(actor.role) ||
    (actor.status !== undefined && actor.status !== "ACTIVE")
  )
    throw new DomainError(
      "FORBIDDEN",
      "You do not have access to Work Report.",
      403,
    );
}
/** This application has one shared team scope; no organization/tenant field exists. */
export function visibilityWhere(actor: WorkReportActor): { deletedAt: null } {
  authorizeWorkReport(actor);
  return { deletedAt: null };
}
export function reportPermissions(
  actor: WorkReportActor,
  report: { authorId: string | null; deletedAt: Date | string | null },
): WorkReportPermissions {
  authorizeWorkReport(actor);
  const own = report.authorId === actor.id && !report.deletedAt;
  return { canEdit: own, canDelete: own };
}
export function authorizeReportOwnership(
  actor: WorkReportActor,
  report: { authorId: string | null; deletedAt: Date | string | null },
): void {
  if (!reportPermissions(actor, report).canEdit)
    throw new DomainError(
      "FORBIDDEN",
      "Only the report's author can change or delete it.",
      403,
    );
}
