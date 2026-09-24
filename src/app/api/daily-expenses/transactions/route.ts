import { api } from "@/lib/api";
import { listDailyExpenseTransactions } from "@/modules/daily-expenses/service";
import { requireDailyExpenseActor } from "../_access";

export function GET(request: Request) {
  return api(async () => {
    const actor = await requireDailyExpenseActor();
    return listDailyExpenseTransactions(
      actor,
      Object.fromEntries(new URL(request.url).searchParams),
    );
  });
}
