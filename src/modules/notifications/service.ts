import "server-only";
import { db } from "@/lib/db";
import type { Actor } from "@/modules/management/permissions";
import {
  canAccessOfficeWork,
  visibilityWhere,
} from "@/modules/office-work/permissions";
import type {
  SidebarNotificationCounts,
  SidebarNotificationHref,
} from "./contracts";

export async function getSidebarNotificationCounts(
  actor: Actor & { employee?: { id: string } | null },
): Promise<SidebarNotificationCounts> {
  const counts: SidebarNotificationCounts = {};
  const pending: Promise<void>[] = [];
  function count(href: SidebarNotificationHref, query: PromiseLike<number>) {
    pending.push(
      Promise.resolve(query).then((total) => {
        counts[href] = total;
      }),
    );
  }

  if (actor.role === "ADMIN" || actor.role === "SUPER_ADMIN") {
    count(
      "/admin/late-approvals",
      db.lateApprovalRequest.count({ where: { status: "PENDING" } }),
    );
    count("/admin/leaves", db.leave.count({ where: { status: "PENDING" } }));
  }
  if (actor.role === "SUPER_ADMIN") {
    count(
      "/admin/overtime-requests",
      db.overtimeRequest.count({ where: { status: "PENDING" } }),
    );
  }
  if (actor.employee) {
    count(
      "/employee/leaves",
      db.leave.count({
        where: { employeeId: actor.employee.id, status: "PENDING" },
      }),
    );
  }
  if (canAccessOfficeWork(actor.role)) {
    count(
      "/office-work",
      db.officeWorkTask.count({
        where: {
          ...visibilityWhere(actor),
          status: "PENDING",
          archivedAt: null,
        },
      }),
    );
  }

  await Promise.all(pending);
  return counts;
}
