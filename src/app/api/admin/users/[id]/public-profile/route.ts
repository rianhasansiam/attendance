import { api, readJson } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { idSchema } from "@/modules/management/validation";
import {
  getManagedPublicProfile,
  updatePublicProfile,
} from "@/modules/public-profile/management";
import { publicProfileUpdateSchema } from "@/modules/public-profile/validation";

type Context = { params: Promise<{ id: string }> };

export function GET(_request: Request, context: Context) {
  return api(async () => {
    const actor = await requireSuperAdmin();
    const { id } = await context.params;
    return getManagedPublicProfile(actor, idSchema.parse(id));
  });
}

export function PATCH(request: Request, context: Context) {
  return api(async () => {
    assertSameOrigin(request);
    const actor = await requireSuperAdmin();
    await rateLimit(`admin-write:${actor.id}`, 120, 60);
    const { id } = await context.params;
    return updatePublicProfile(
      actor,
      idSchema.parse(id),
      await readJson(request, publicProfileUpdateSchema),
    );
  });
}
