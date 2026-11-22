import { api, readJson } from "@/lib/api";
import {
  workReportCreateSchema,
  workReportListSchema,
} from "@/modules/work-report/contracts";
import {
  createWorkReport,
  listWorkReports,
} from "@/modules/work-report/service";
import { requireWorkReportActor } from "./_access";

export function GET(request: Request) {
  return api(async () => {
    const actor = await requireWorkReportActor();
    return listWorkReports(
      actor,
      workReportListSchema.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      ),
    );
  });
}

export function POST(request: Request) {
  return api(async () => {
    const actor = await requireWorkReportActor(request);
    return createWorkReport(
      actor,
      await readJson(request, workReportCreateSchema),
    );
  });
}
