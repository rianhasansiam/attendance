import { api } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import {
  listLookupOptions,
  lookupResourceSchema,
} from "@/modules/management/lookups";
import { paginationSchema } from "@/modules/management/validation";

export function GET(
  request: Request,
  context: { params: Promise<{ resource: string }> },
) {
  return api(async () => {
    await requireAdmin();
    const resource = lookupResourceSchema.parse(
      (await context.params).resource,
    );
    const query = paginationSchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return listLookupOptions(resource, query);
  });
}
