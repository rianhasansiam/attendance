import { api, readJson } from "@/lib/api";
import { expenseInputSchema } from "@/modules/daily-expenses/contracts";
import { addDailyExpense } from "@/modules/daily-expenses/service";
import { requireDailyExpenseActor } from "../_access";

export function POST(request: Request) {
  return api(async () => {
    const actor = await requireDailyExpenseActor(request);
    return addDailyExpense(actor, await readJson(request, expenseInputSchema));
  });
}
