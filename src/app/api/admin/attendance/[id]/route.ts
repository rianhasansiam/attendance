import { api, readJson } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { correctionSchema, idSchema } from "@/modules/management/validation";
import { correctAttendance } from "@/modules/management/workflows";

export function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return api(async () => {
    assertSameOrigin(request);
    const actor = await requireSuperAdmin();
    await rateLimit(`admin-write:${actor.id}`, 120, 60);
    return correctAttendance(
      actor,
      idSchema.parse((await context.params).id),
      await readJson(request, correctionSchema),
    );
  });
}
