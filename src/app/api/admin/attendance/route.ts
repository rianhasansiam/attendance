export { GET } from "@/app/api/admin/reports/route";
import { api, readJson } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { newCorrectionSchema } from "@/modules/management/validation";
import { createAttendanceCorrection } from "@/modules/management/workflows";
import { sanitizeAttendance } from "@/modules/attendance/service";

export function POST(request: Request) {
  return api(async () => {
    assertSameOrigin(request);
    const actor = await requireSuperAdmin();
    await rateLimit(`admin-write:${actor.id}`, 120, 60);
    return sanitizeAttendance(
      await createAttendanceCorrection(
        actor,
        await readJson(request, newCorrectionSchema),
      ),
    );
  });
}
