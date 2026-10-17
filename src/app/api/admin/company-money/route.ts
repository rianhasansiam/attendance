import { api, readJson } from "@/lib/api";
import { requireAdmin, requireSuperAdmin } from "@/lib/auth";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import {
  companyMoneyInputSchema,
  companyMoneyListSchema,
} from "@/modules/company-money/contracts";
import {
  getCompanyMoneyOverview,
  recordCompanyMoneyTransaction,
} from "@/modules/company-money/service";

export function GET(request: Request) {
  return api(async () => {
    const actor = await requireAdmin();
    const query = companyMoneyListSchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return getCompanyMoneyOverview(actor, query);
  });
}

export function POST(request: Request) {
  return api(async () => {
    assertSameOrigin(request);
    const actor = await requireSuperAdmin();
    await rateLimit(`admin-write:${actor.id}`, 120, 60);
    return recordCompanyMoneyTransaction(
      actor,
      await readJson(request, companyMoneyInputSchema),
    );
  });
}
