import { api } from "@/lib/api";
import { workReportAuthorsQuerySchema } from "@/modules/work-report/contracts";
import { listWorkReportAuthors } from "@/modules/work-report/service";
import { requireWorkReportActor } from "../_access";

export function GET(request: Request) {
  return api(async () => {
    const actor = await requireWorkReportActor();
    return listWorkReportAuthors(
      actor,
      workReportAuthorsQuerySchema.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      ),
    );
  });
}
