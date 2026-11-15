import { handleAttendanceRequest } from "@/modules/attendance/http";
import { api } from "@/lib/api";
import { requireEmployee } from "@/lib/auth";
import { rateLimit } from "@/lib/security";
import { previewCheckout } from "@/modules/attendance/service";

export function GET() {
  return api(async () => {
    const actor = await requireEmployee();
    await rateLimit(`attendance-preview:${actor.id}`, 30, 60);
    return previewCheckout(actor);
  });
}

export function POST(request: Request) {
  return handleAttendanceRequest(request, "CHECK_OUT");
}
