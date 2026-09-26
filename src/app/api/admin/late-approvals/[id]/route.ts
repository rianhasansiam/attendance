import { api, readJson } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { idSchema } from "@/modules/management/validation";
import {
  lateApprovalReviewSchema,
  reviewLateApproval,
} from "@/modules/attendance/late-approval";

export function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return api(async () => {
    assertSameOrigin(request);
    const actor = await requireAdmin();
    await rateLimit(`admin-write:${actor.id}`, 120, 60);
    return reviewLateApproval(
      actor,
      idSchema.parse((await context.params).id),
      await readJson(request, lateApprovalReviewSchema),
    );
  });
}
