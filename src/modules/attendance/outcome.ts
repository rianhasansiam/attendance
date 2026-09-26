import { calculateOvertime } from "@/modules/shifts/calculations";

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
    ...overtime,
  };
}
