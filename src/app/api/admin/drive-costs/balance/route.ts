import { api, readJson } from "@/lib/api";
import { requireDriveCostManager, requireSuperAdmin } from "@/lib/auth";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import {
  addDriveCostBalance,
  getDriveCostBalance,
} from "@/modules/drive-costs/balance";
import { driveCostBalanceInputSchema } from "@/modules/drive-costs/balance-validation";

export function GET() {
  return api(async () => getDriveCostBalance(await requireDriveCostManager()));
}

export function POST(request: Request) {
  return api(async () => {
    assertSameOrigin(request);
    const actor = await requireSuperAdmin();
    await rateLimit(`admin-write:${actor.id}`, 120, 60);
    return addDriveCostBalance(
      actor,
      await readJson(request, driveCostBalanceInputSchema),
    );
  });
}
