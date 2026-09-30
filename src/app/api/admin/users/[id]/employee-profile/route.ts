import { api, readJson } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth";
import { invalidateReferenceDisplay } from "@/lib/cache/invalidation";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { createEmployeeProfile } from "@/modules/employees/service";
import {
  employeeProfileCreateSchema,
  idSchema,
} from "@/modules/management/validation";

type Context = { params: Promise<{ id: string }> };

export function POST(request: Request, context: Context) {
  return api(async () => {
    assertSameOrigin(request);
    const actor = await requireSuperAdmin();
    await rateLimit(`admin-write:${actor.id}`, 120, 60);
    const { id } = await context.params;
    const result = await createEmployeeProfile(
      actor,
      idSchema.parse(id),
      await readJson(request, employeeProfileCreateSchema),
    );
    invalidateReferenceDisplay("employees");
    return result;
  });
}
