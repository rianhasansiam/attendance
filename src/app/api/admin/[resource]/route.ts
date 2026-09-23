import { z } from "zod";
import { api, readJson } from "@/lib/api";
import { requireAdmin, requireDriveCostManager } from "@/lib/auth";
import { invalidateReferenceDisplay } from "@/lib/cache/invalidation";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import {
  createRecord,
  listRecords,
  resourceSchema,
} from "@/modules/management/service";
import {
  driveCostFilterSchema,
  paginationSchema,
} from "@/modules/management/validation";

type Context = { params: Promise<{ resource: string }> };

export function GET(request: Request, context: Context) {
  return api(async () => {
    const resource = resourceSchema.parse((await context.params).resource);
    const actor = await (resource === "drive-costs"
      ? requireDriveCostManager()
      : requireAdmin());
    const querySchema =
      resource === "drive-costs" ? driveCostFilterSchema : paginationSchema;
    return listRecords(
      actor,
      resource,
      querySchema.parse(Object.fromEntries(new URL(request.url).searchParams)),
    );
  });
}

export function POST(request: Request, context: Context) {
  return api(async () => {
    assertSameOrigin(request);
    const resource = resourceSchema.parse((await context.params).resource);
    const actor = await (resource === "drive-costs"
      ? requireDriveCostManager()
      : requireAdmin());
    await rateLimit(`admin-write:${actor.id}`, 120, 60);
    const result = await createRecord(
      actor,
      resource,
      await readJson(request, z.record(z.string(), z.unknown())),
    );
    invalidateReferenceDisplay(resource);
    return result;
  });
}
