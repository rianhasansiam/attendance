import { api, readJson } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { idSchema } from "@/modules/management/validation";
import {
  overtimeRequestReviewSchema,
  reviewOvertimeRequest,
} from "@/modules/attendance/overtime-approval";

export function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return api(async () => {
    assertSameOrigin(request);
    const actor = await requireSuperAdmin();
    await rateLimit(`admin-write:${actor.id}`, 120, 60);
    return reviewOvertimeRequest(
      actor,
      idSchema.parse((await context.params).id),
      await readJson(request, overtimeRequestReviewSchema),
    );
  });
}
