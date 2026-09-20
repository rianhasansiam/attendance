import { api } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { rateLimit } from "@/lib/security";
import { reportFilterSchema } from "@/modules/management/validation";
import { getReport } from "@/modules/reports/service";

export function GET(request: Request) {
  return api(async () => {
    const actor = await requireAdmin();
    await rateLimit(`reports:${actor.id}`, 30, 60);
    return getReport(
      reportFilterSchema.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      ),
    );
  });
}
