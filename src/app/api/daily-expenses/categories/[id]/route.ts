import { api, readJson } from "@/lib/api";
import { categoryUpdateSchema } from "@/modules/daily-expenses/contracts";
import { updateDailyExpenseCategory } from "@/modules/daily-expenses/service";
import { requireDailyExpenseActor } from "../../_access";

export function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return api(async () => {
    const actor = await requireDailyExpenseActor(request);
    const { id } = await context.params;
    return updateDailyExpenseCategory(
      actor,
      id,
      await readJson(request, categoryUpdateSchema),
    );
  });
}
