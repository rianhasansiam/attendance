import { api, readJson } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { updateDriveCostPaymentStatus } from "@/modules/drive-costs/payment-status";
import {
  driveCostPaymentStatusSchema,
  idSchema,
} from "@/modules/management/validation";

export function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return api(async () => {
    assertSameOrigin(request);
    const actor = await requireSuperAdmin();
    await rateLimit(`admin-write:${actor.id}`, 120, 60);
    const { id } = await context.params;
    return updateDriveCostPaymentStatus(
      actor,
      idSchema.parse(id),
      await readJson(request, driveCostPaymentStatusSchema),
    );
  });
}
