import { api, readJson } from "@/lib/api";
import {
  officeWorkCreateSchema,
  officeWorkListSchema,
} from "@/modules/office-work/contracts";
import {
  createOfficeWorkTask,
  getOfficeWorkOverview,
} from "@/modules/office-work/service";
import { requireOfficeWorkActor } from "./_access";

export function GET(request: Request) {
  return api(async () => {
    const actor = await requireOfficeWorkActor();
    return getOfficeWorkOverview(
      actor,
      officeWorkListSchema.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      ),
    );
  });
}

export function POST(request: Request) {
  return api(async () => {
    const actor = await requireOfficeWorkActor(request);
    return createOfficeWorkTask(
      actor,
      await readJson(request, officeWorkCreateSchema),
    );
  });
}
