import { api, readJson } from "@/lib/api";
import {
  workReportDeleteSchema,
  workReportIdSchema,
  workReportUpdateSchema,
} from "@/modules/work-report/contracts";
import {
  deleteWorkReport,
  getWorkReport,
  updateWorkReport,
} from "@/modules/work-report/service";
import { requireWorkReportActor } from "../_access";

type Context = { params: Promise<{ id: string }> };

export function GET(_request: Request, context: Context) {
  return api(async () => {
    const actor = await requireWorkReportActor();
    return getWorkReport(
      actor,
      workReportIdSchema.parse((await context.params).id),
    );
  });
}

export function PATCH(request: Request, context: Context) {
  return api(async () => {
    const actor = await requireWorkReportActor(request);
    return updateWorkReport(
      actor,
      workReportIdSchema.parse((await context.params).id),
      await readJson(request, workReportUpdateSchema),
    );
  });
}

export function DELETE(request: Request, context: Context) {
  return api(async () => {
    const actor = await requireWorkReportActor(request);
    return deleteWorkReport(
      actor,
      workReportIdSchema.parse((await context.params).id),
      await readJson(request, workReportDeleteSchema),
    );
  });
}
