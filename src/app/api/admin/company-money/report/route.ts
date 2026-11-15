import { getLocale } from "next-intl/server";
import { resolveLocale } from "@/i18n/config";
import { api } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { rateLimit } from "@/lib/security";
import { companyMoneyReportQuerySchema } from "@/modules/company-money/contracts";
import { getCompanyMoneyReport } from "@/modules/company-money/report";

export function GET(request: Request) {
  return api(async () => {
    const actor = await requireAdmin();
    await rateLimit(`company-money-reports:${actor.id}`, 30, 60);
    const filters = companyMoneyReportQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return getCompanyMoneyReport(
      actor,
      filters,
      resolveLocale(await getLocale()),
    );
  });
}
