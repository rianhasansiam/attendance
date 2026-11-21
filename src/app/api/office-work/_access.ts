import "server-only";
import { requireUser } from "@/lib/auth";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { authorizeOfficeWork } from "@/modules/office-work/permissions";

/** Keep the existing session, CSRF, and write-throttling protections. */
export async function requireOfficeWorkActor(mutation?: Request) {
  if (mutation) assertSameOrigin(mutation);
  const actor = await requireUser();
  authorizeOfficeWork(actor);
  if (mutation) await rateLimit(`office-work-write:${actor.id}`, 120, 60);
  return actor;
}
