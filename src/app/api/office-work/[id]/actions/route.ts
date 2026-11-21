import { api, readJson } from "@/lib/api";
import {
  officeWorkActionSchema,
  officeWorkIdSchema,
} from "@/modules/office-work/contracts";
import { mutateOfficeWorkTask } from "@/modules/office-work/service";
import { requireOfficeWorkActor } from "../../_access";

export function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return api(async () => {
    const actor = await requireOfficeWorkActor(request);
    return mutateOfficeWorkTask(
      actor,
      officeWorkIdSchema.parse((await context.params).id),
      await readJson(request, officeWorkActionSchema),
    );
  });
}
