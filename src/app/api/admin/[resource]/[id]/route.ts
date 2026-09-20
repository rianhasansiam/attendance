import { z } from "zod";
import { api, readJson } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { invalidateReferenceDisplay } from "@/lib/cache/invalidation";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import {
  getRecord,
  removeRecord,
  resourceSchema,
  updateRecord,
} from "@/modules/management/service";
import { idSchema } from "@/modules/management/validation";

type Context = { params: Promise<{ resource: string; id: string }> };

export function GET(_request: Request, context: Context) {
  return api(async () => {
    const actor = await requireAdmin();
    const params = await context.params;
    return getRecord(
      actor,
      resourceSchema.parse(params.resource),
      idSchema.parse(params.id),
    );
  });
}

export function PATCH(request: Request, context: Context) {
  return api(async () => {
    assertSameOrigin(request);
    const actor = await requireAdmin();
    await rateLimit(`admin-write:${actor.id}`, 120, 60);
    const params = await context.params;
    const resource = resourceSchema.parse(params.resource);
    const result = await updateRecord(
      actor,
      resource,
      idSchema.parse(params.id),
      await readJson(request, z.record(z.string(), z.unknown())),
    );
    invalidateReferenceDisplay(resource);
    return result;
  });
}

export function DELETE(request: Request, context: Context) {
  return api(async () => {
    assertSameOrigin(request);
    const actor = await requireAdmin();
    await rateLimit(`admin-write:${actor.id}`, 120, 60);
    const params = await context.params;
    const resource = resourceSchema.parse(params.resource);
    const result = await removeRecord(
      actor,
      resource,
      idSchema.parse(params.id),
    );
    invalidateReferenceDisplay(resource);
    return result;
  });
}
