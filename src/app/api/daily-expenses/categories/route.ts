import { api, readJson } from "@/lib/api";
import { categoryCreateSchema } from "@/modules/daily-expenses/contracts";
import {
  createDailyExpenseCategory,
  listDailyExpenseCategories,
} from "@/modules/daily-expenses/service";
import { requireDailyExpenseActor } from "../_access";

export function GET() {
  return api(async () =>
    listDailyExpenseCategories(await requireDailyExpenseActor()),
  );
}

export function POST(request: Request) {
  return api(async () => {
    const actor = await requireDailyExpenseActor(request);
    return createDailyExpenseCategory(
      actor,
      await readJson(request, categoryCreateSchema),
    );
  });
}
