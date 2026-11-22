import { api } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getSidebarNotificationCounts } from "@/modules/notifications/service";

export function GET() {
  return api(async () => getSidebarNotificationCounts(await requireUser()));
}
