import { api, readJson } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { idSchema } from "@/modules/management/validation";
import {
  companyMoneyUpdateSchema,
  companyMoneyDeleteSchema,
} from "@/modules/company-money/contracts";
import {
  updateCompanyMoneyTransaction,
  deleteCompanyMoneyTransaction,
} from "@/modules/company-money/service";

type Context = { params: Promise<{ id: string }> };

export function PATCH(request: Request, context: Context) {
  return api(async () => {
    assertSameOrigin(request);
    const actor = await requireSuperAdmin();
    await rateLimit(`admin-write:${actor.id}`, 120, 60);
    return updateCompanyMoneyTransaction(
      actor,
      idSchema.parse((await context.params).id),
      await readJson(request, companyMoneyUpdateSchema),
    );
  });
}

export function DELETE(request: Request, context: Context) {
  return api(async () => {
    assertSameOrigin(request);
    const actor = await requireSuperAdmin();
    await rateLimit(`admin-write:${actor.id}`, 120, 60);
    return deleteCompanyMoneyTransaction(
      actor,
      idSchema.parse((await context.params).id),
      await readJson(request, companyMoneyDeleteSchema),
    );
  });
}
