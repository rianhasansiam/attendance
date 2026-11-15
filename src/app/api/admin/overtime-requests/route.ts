import { api } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth";
import {
  listOvertimeRequests,
  overtimeRequestFilterSchema,
} from "@/modules/attendance/overtime-approval";

export function GET(request: Request) {
  return api(async () =>
    listOvertimeRequests(
      await requireSuperAdmin(),
      overtimeRequestFilterSchema.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      ),
    ),
  );
}
