import "server-only";
import { requireUser } from "@/lib/auth";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { authorizeDailyExpenses } from "@/modules/daily-expenses/permissions";

export async function requireDailyExpenseActor(mutation?: Request) {
  const actor = await requireUser();
  authorizeDailyExpenses(actor);
  if (mutation) {
    assertSameOrigin(mutation);
    await rateLimit(`daily-expenses-write:${actor.id}`, 120, 60);
  }
  return actor;
}
