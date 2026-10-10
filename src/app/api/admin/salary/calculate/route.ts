import { api, readJson } from "@/lib/api";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { salaryCalculateInputSchema } from "@/modules/salary/contracts";
import { calculateSalaries } from "@/modules/salary/service";
import { requireSalaryAccess } from "../_access";

export function POST(request: Request) {
  return api(async () => {
    const actor = await requireSalaryAccess();
    assertSameOrigin(request);
    await rateLimit(`salary-calculate:${actor.id}`, 30, 60);
    const input = await readJson(request, salaryCalculateInputSchema);
    return { items: await calculateSalaries(actor, input) };
  });
}
