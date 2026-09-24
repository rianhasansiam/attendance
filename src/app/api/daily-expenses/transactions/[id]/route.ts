import { api, readJson } from "@/lib/api";
import {
  transactionUpdateSchema,
  transactionDeleteSchema,
} from "@/modules/daily-expenses/contracts";
import {
  authorizeDailyExpenseTransactionEdit,
  authorizeDailyExpenseTransactionDelete,
} from "@/modules/daily-expenses/permissions";
import {
  updateDailyExpenseTransaction,
  deleteDailyExpenseTransaction,
} from "@/modules/daily-expenses/service";
import { requireDailyExpenseActor } from "../../_access";

export function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return api(async () => {
    const actor = await requireDailyExpenseActor(request);
    authorizeDailyExpenseTransactionEdit(actor);
    const { id } = await context.params;
    return updateDailyExpenseTransaction(
      actor,
      id,
      await readJson(request, transactionUpdateSchema),
    );
  });
}

export function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return api(async () => {
    const actor = await requireDailyExpenseActor(request);
    authorizeDailyExpenseTransactionDelete(actor);
    const { id } = await context.params;
    return deleteDailyExpenseTransaction(
      actor,
      id,
      await readJson(request, transactionDeleteSchema),
    );
  });
}
