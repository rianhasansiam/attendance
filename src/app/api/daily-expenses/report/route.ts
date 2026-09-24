import { api } from "@/lib/api";
import { rateLimit } from "@/lib/security";
import { authorizeDailyExpenseReport } from "@/modules/daily-expenses/permissions";
import { getDailyExpenseReport } from "@/modules/daily-expenses/report";
import { requireDailyExpenseActor } from "../_access";

export function GET(request: Request) {
  return api(async () => {
    const actor = await requireDailyExpenseActor();
    authorizeDailyExpenseReport(actor);
    await rateLimit(`daily-expenses-reports:${actor.id}`, 30, 60);
    return getDailyExpenseReport(
      actor,
      Object.fromEntries(new URL(request.url).searchParams),
    );
  });
}
