import { api, readJson } from "@/lib/api";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import {
  salaryEmployeeIdSchema,
  salarySettingsInputSchema,
} from "@/modules/salary/contracts";
import { saveSalarySettings } from "@/modules/salary/service";
import { requireSalaryAccess } from "../_access";

const settingsRequestSchema = salarySettingsInputSchema.extend({
  employeeId: salaryEmployeeIdSchema,
});

export function POST(request: Request) {
  return api(async () => {
    const actor = await requireSalaryAccess();
    assertSameOrigin(request);
    await rateLimit(`salary-settings:${actor.id}`, 30, 60);
    const { employeeId, ...input } = await readJson(
      request,
      settingsRequestSchema,
    );
    return saveSalarySettings(actor, employeeId, input);
  });
}
