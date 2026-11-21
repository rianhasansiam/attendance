import { api, readJson } from "@/lib/api";
import {
  officeWorkActivityQuerySchema,
  officeWorkIdSchema,
  officeWorkUpdateSchema,
} from "@/modules/office-work/contracts";
import {
  getOfficeWorkTask,
  updateOfficeWorkTask,
} from "@/modules/office-work/service";
import { requireOfficeWorkActor } from "../_access";

type Context = { params: Promise<{ id: string }> };

export function GET(request: Request, context: Context) {
  return api(async () => {
    const actor = await requireOfficeWorkActor();
    return getOfficeWorkTask(
      actor,
      officeWorkIdSchema.parse((await context.params).id),
      officeWorkActivityQuerySchema.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      ),
    );
  });
}

export function PATCH(request: Request, context: Context) {
  return api(async () => {
    const actor = await requireOfficeWorkActor(request);
    return updateOfficeWorkTask(
      actor,
      officeWorkIdSchema.parse((await context.params).id),
      await readJson(request, officeWorkUpdateSchema),
    );
  });
}
