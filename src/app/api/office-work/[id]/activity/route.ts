import { api } from "@/lib/api";
import {
  officeWorkActivityQuerySchema,
  officeWorkIdSchema,
} from "@/modules/office-work/contracts";
import { getOfficeWorkTask } from "@/modules/office-work/service";
import { requireOfficeWorkActor } from "../../_access";

export function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return api(async () => {
    const actor = await requireOfficeWorkActor();
    // Authorize against the current task before reading its retained history.
    const detail = await getOfficeWorkTask(
      actor,
      officeWorkIdSchema.parse((await context.params).id),
      officeWorkActivityQuerySchema.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      ),
    );
    return {
      items: detail.activities,
      total: detail.activityTotal,
      page: detail.activityPage,
      pageSize: detail.activityPageSize,
    };
  });
}
