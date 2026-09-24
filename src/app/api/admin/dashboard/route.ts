import { api } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { getAdminDashboard } from "@/modules/reports/service";

export function GET() {
  return api(async () => {
    const actor = await requireAdmin();
    return getAdminDashboard(actor);
  });
}
