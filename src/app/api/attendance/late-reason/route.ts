import { handleLateReasonRequest } from "@/modules/attendance/http";

export function POST(request: Request) {
  return handleLateReasonRequest(request);
}
