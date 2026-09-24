import { api } from "@/lib/api";
import { requireDriveCostManager } from "@/lib/auth";
import { rateLimit } from "@/lib/security";
import { getDriveCostReport } from "@/modules/drive-costs/report";
import { driveCostFilterSchema } from "@/modules/management/validation";

export function GET(request: Request) {
  return api(async () => {
    const actor = await requireDriveCostManager();
    await rateLimit(`drive-cost-reports:${actor.id}`, 30, 60);
    const params = new URL(request.url).searchParams;
    return getDriveCostReport(
      actor,
      driveCostFilterSchema.parse({
        from: params.get("from") ?? undefined,
        to: params.get("to") ?? undefined,
        q: params.get("q") ?? undefined,
      }),
    );
  });
}
