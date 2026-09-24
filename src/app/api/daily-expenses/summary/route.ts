import { api } from "@/lib/api";
import { getDailyExpensesSummary } from "@/modules/daily-expenses/service";
import { requireDailyExpenseActor } from "../_access";

export function GET() {
  return api(async () =>
    getDailyExpensesSummary(await requireDailyExpenseActor()),
  );
}
