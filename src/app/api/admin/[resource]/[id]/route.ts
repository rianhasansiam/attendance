import { z } from "zod";
import { api, readJson } from "@/lib/api";
import { requireAdmin, requireDriveCostManager } from "@/lib/auth";
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
    const params = await context.params;
    const resource = resourceSchema.parse(params.resource);
    const actor = await (resource === "drive-costs"
      ? requireDriveCostManager()
      : requireAdmin());
    return getRecord(actor, resource, idSchema.parse(params.id));
  });
}

export function PATCH(request: Request, context: Context) {
  return api(async () => {
    assertSameOrigin(request);
    const params = await context.params;
    const resource = resourceSchema.parse(params.resource);
    const actor = await (resource === "drive-costs"
      ? requireDriveCostManager()
      : requireAdmin());
    await rateLimit(`admin-write:${actor.id}`, 120, 60);
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
    const params = await context.params;
    const resource = resourceSchema.parse(params.resource);
    const actor = await (resource === "drive-costs"
      ? requireDriveCostManager()
      : requireAdmin());
    await rateLimit(`admin-write:${actor.id}`, 120, 60);
    const result = await removeRecord(
      actor,
      resource,
      idSchema.parse(params.id),
    );
    invalidateReferenceDisplay(resource);
    return result;
  });
}
