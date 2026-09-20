import { api } from "@/lib/api";
import { requireEmployee } from "@/lib/auth";
import { employeeDashboard } from "@/modules/attendance/service";
export function GET(request: Request) {
  return api(async () =>
    employeeDashboard(await requireEmployee(), request.headers),
  );
}
