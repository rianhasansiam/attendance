import { z } from "zod";
import { api, readJson } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import {
  createRecord,
  listRecords,
  resourceSchema,
} from "@/modules/management/service";
import { paginationSchema } from "@/modules/management/validation";

type Context = { params: Promise<{ resource: string }> };

export function GET(request: Request, context: Context) {
  return api(async () => {
    const actor = await requireAdmin();
    const resource = resourceSchema.parse((await context.params).resource);
    return listRecords(
      actor,
      resource,
      paginationSchema.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      ),
    );
  });
}

export function POST(request: Request, context: Context) {
  return api(async () => {
    assertSameOrigin(request);
    const actor = await requireAdmin();
    await rateLimit(`admin-write:${actor.id}`, 120, 60);
    const resource = resourceSchema.parse((await context.params).resource);
    return createRecord(
      actor,
      resource,
      await readJson(request, z.record(z.string(), z.unknown())),
    );
  });
}
