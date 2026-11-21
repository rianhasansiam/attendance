import { api } from "@/lib/api";
import { officeWorkAssigneesQuerySchema } from "@/modules/office-work/contracts";
import { listOfficeWorkAssignees } from "@/modules/office-work/service";
import { requireOfficeWorkActor } from "../_access";

export function GET(request: Request) {
  return api(async () => {
    const actor = await requireOfficeWorkActor();
    return listOfficeWorkAssignees(
      actor,
      officeWorkAssigneesQuerySchema.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      ),
    );
  });
}
