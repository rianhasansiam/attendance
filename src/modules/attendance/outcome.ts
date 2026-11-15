import { calculateOvertime } from "@/modules/shifts/calculations";
import {
  calculateEligibleOvertime,
  MINIMUM_ELIGIBLE_OVERTIME_MINUTES,
} from "./overtime-policy";

type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";
type AttendanceFacts = {
  checkInAt: Date | null;
  lateMinutes: number;
};
type ApprovalFacts = {
  status: ApprovalStatus;
  checkInAt: Date;
  lateMinutes: number;
};
type OvertimeAttendanceFacts = {
  checkInAt: Date | null;
  checkOutAt: Date | null;
  scheduledEndAt?: Date | null;
};
type OvertimeRequestFacts = {
  id?: string;
  status: ApprovalStatus;
  checkInAt: Date;
  checkOutAt: Date;
  scheduledEndAt: Date;
  requestedMinutes: number;
  updatedAt?: Date;
};

/** Corrected attendance cannot use an approval for different captured facts. */
export function overtimeRequestMatchesAttendance(
  attendance: OvertimeAttendanceFacts,
  request: Pick<
    OvertimeRequestFacts,
    "checkInAt" | "checkOutAt" | "scheduledEndAt" | "requestedMinutes"
  >,
): boolean {
  return Boolean(
    attendance.checkInAt &&
    attendance.checkOutAt &&
    attendance.scheduledEndAt &&
    attendance.checkInAt.getTime() === request.checkInAt.getTime() &&
    attendance.checkOutAt.getTime() === request.checkOutAt.getTime() &&
    attendance.scheduledEndAt.getTime() === request.scheduledEndAt.getTime() &&
    request.requestedMinutes >= MINIMUM_ELIGIBLE_OVERTIME_MINUTES &&
    request.requestedMinutes ===
      calculateEligibleOvertime(
        attendance.checkInAt,
        attendance.checkOutAt,
        attendance.scheduledEndAt,
      ),
  );
}

/** An approval applies only to the attendance facts the reviewer approved. */
export function approvalMatchesAttendance(
  attendance: AttendanceFacts,
  approval: Pick<ApprovalFacts, "checkInAt" | "lateMinutes">,
) {
  return (
    attendance.checkInAt !== null &&
    attendance.checkInAt.getTime() === approval.checkInAt.getTime() &&
    attendance.lateMinutes === approval.lateMinutes
  );
}

export type AttendanceOutcomeInput<Status extends string = string> = {
  status: Status;
  lateMinutes: number;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  overtimeMinutes: number | null;
  scheduledEndAt?: Date | null;
  lateApproval?: ApprovalFacts | null;
  overtimeRequest?: OvertimeRequestFacts | null;
};

/** Shared server projection for attendance history, dashboards and exports. */
export function attendanceOutcome<Status extends string>(
  record: AttendanceOutcomeInput<Status>,
) {
  const approval = record.lateApproval;
  const isExcusedLate = Boolean(
    record.lateMinutes > 0 &&
    approval?.status === "APPROVED" &&
    approvalMatchesAttendance(record, approval),
  );
  const overtime =
    record.checkInAt && record.checkOutAt && record.scheduledEndAt
      ? calculateOvertime(
          record.checkInAt,
          record.checkOutAt,
          record.lateMinutes,
          record.scheduledEndAt,
        )
      : {
          overtimeMinutes: record.overtimeMinutes,
          rawOvertimeMinutes: record.checkOutAt ? null : 0,
        };
  const request = record.overtimeRequest;
  const overtimeApprovalMatchesAttendance = Boolean(
    request && overtimeRequestMatchesAttendance(record, request),
  );
  return {
    status:
      isExcusedLate && record.status === "LATE"
        ? ("PRESENT" as const)
        : record.status,
    actualStatus: record.status,
    actualLateMinutes: record.lateMinutes,
    effectiveLateMinutes: isExcusedLate ? 0 : record.lateMinutes,
    isExcusedLate,
    lateApprovalStatus: approval?.status ?? null,
    requestedOvertimeMinutes: request?.requestedMinutes ?? null,
    approvedOvertimeMinutes:
      request?.status === "APPROVED" && overtimeApprovalMatchesAttendance
        ? request.requestedMinutes
        : 0,
    overtimeRequestStatus: request?.status ?? null,
    overtimeApprovalMatchesAttendance,
    overtimeRequestId: request?.id ?? null,
    overtimeRequestUpdatedAt: request?.updatedAt ?? null,
    ...overtime,
  };
}
