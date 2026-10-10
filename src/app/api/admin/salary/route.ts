import { api } from "@/lib/api";
import { rateLimit } from "@/lib/security";
import { initialConfiguration } from "@/modules/daily-expenses/service";
import { salaryQuerySchema } from "@/modules/salary/contracts";
import { listSalaryEmployees } from "@/modules/salary/service";
import { shiftDate } from "@/modules/shifts/calculations";
import { requireSalaryAccess } from "./_access";

export function GET(request: Request) {
  return api(async () => {
    const actor = await requireSalaryAccess();
    await rateLimit(`salary-list:${actor.id}`, 120, 60);
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const query = salaryQuerySchema.parse({
      ...params,
      period:
        params.period ??
        params.from?.slice(0, 7) ??
        shiftDate(new Date(), initialConfiguration().timezone).slice(0, 7),
    });
    return listSalaryEmployees(actor, query);
  });
}
