import { api, readJson } from "@/lib/api";
import { balanceInputSchema } from "@/modules/daily-expenses/contracts";
import { addDailyExpenseBalance } from "@/modules/daily-expenses/service";
import { requireDailyExpenseActor } from "../_access";

export function POST(request: Request) {
  return api(async () => {
    const actor = await requireDailyExpenseActor(request);
    return addDailyExpenseBalance(
      actor,
      await readJson(request, balanceInputSchema),
    );
  });
}
