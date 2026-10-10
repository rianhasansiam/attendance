import "server-only";
import { requireUser } from "@/lib/auth";
import { assertSuperAdmin } from "@/modules/management/permissions";

/** Salary information has no delegated ADMIN permission in this application. */
export async function requireSalaryAccess() {
  const actor = await requireUser();
  assertSuperAdmin(actor);
  return actor;
}
