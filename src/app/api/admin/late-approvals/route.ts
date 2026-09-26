import { api } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import {
  lateApprovalFilterSchema,
  listLateApprovals,
} from "@/modules/attendance/late-approval";

export function GET(request: Request) {
  return api(async () =>
    listLateApprovals(
      await requireAdmin(),
      lateApprovalFilterSchema.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      ),
    ),
  );
}
