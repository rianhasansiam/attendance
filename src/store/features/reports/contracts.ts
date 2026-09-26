import type { JsonRecord, PageDto } from "../management/contracts";

export type AttendanceStatus =
  "PRESENT" | "LATE" | "ABSENT" | "HALF_DAY" | "LEAVE" | "HOLIDAY" | "WEEKEND";
export type ReportFilters = {
  employeeId?: string;
  departmentId?: string;
  officeId?: string;
  shiftId?: string;
  status?: AttendanceStatus;
  from?: string;
  to?: string;
};
export type ReportQuery = ReportFilters & { page: number; pageSize: number };
export type AttendanceReportRow = JsonRecord & {
  id: string;
  employee: JsonRecord & {
    id: string;
    employeeCode: string;
    user: JsonRecord & { name: string | null };
  };
  office: JsonRecord & { id: string; name: string; timezone: string };
  shift: JsonRecord & { id: string; name: string };
  attendanceDate: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  workedMinutes: number;
  overtimeMinutes: number | null;
  lateMinutes: number;
  lateReason: string | null;
  status: AttendanceStatus;
  actualStatus?: AttendanceStatus;
  actualLateMinutes?: number;
  effectiveLateMinutes?: number;
  isExcusedLate?: boolean;
  lateApprovalStatus?: "PENDING" | "APPROVED" | "REJECTED" | null;
  rawOvertimeMinutes?: number | null;
  derived: boolean;
};
export type ReportPage = PageDto<AttendanceReportRow> & {
  summary: { overtimeMinutes: number; unknownOvertimeRecords: number };
};
export type AdminDashboardDto = {
  totalEmployees: number;
  presentToday: number;
  lateToday: number;
  absentToday: number;
  currentlyCheckedIn: number;
  checkedOut: number;
  recentAttendance: AttendanceReportRow[];
};
export type CorrectionInput = {
  reason: string;
  status: AttendanceStatus;
  checkInAt: string | null;
  checkOutAt: string | null;
};
export type CorrectionWrite =
  | { id: string; body: CorrectionInput }
  | {
      id?: undefined;
      body: CorrectionInput & { employeeId: string; attendanceDate: string };
    };
