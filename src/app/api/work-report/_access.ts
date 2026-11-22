import "server-only";
import { requireUser } from "@/lib/auth";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { authorizeWorkReport } from "@/modules/work-report/permissions";

export async function requireWorkReportActor(mutation?: Request) {
  if (mutation) assertSameOrigin(mutation);
  const actor = await requireUser();
  authorizeWorkReport(actor);
  if (mutation) await rateLimit(`work-report-write:${actor.id}`, 120, 60);
  return actor;
}
