import { handleAttendanceRequest } from "@/modules/attendance/http";
export function POST(request: Request) {
  return handleAttendanceRequest(request, "CHECK_IN");
}
