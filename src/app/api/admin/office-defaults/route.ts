import { api } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { getOfficePolicyDefaults } from "@/modules/management/catalog";

export function GET() {
  return api(async () => {
    await requireAdmin();
    return getOfficePolicyDefaults();
  });
}
