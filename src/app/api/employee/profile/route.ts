import { api } from "@/lib/api";
import { requireEmployee } from "@/lib/auth";
import { getOwnEmployeeProfile } from "@/modules/employees/service";

export function GET() {
  return api(async () => {
    const user = await requireEmployee();
    return getOwnEmployeeProfile(user);
  });
}
