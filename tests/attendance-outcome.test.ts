import { describe, expect, it } from "vitest";
import { attendanceOutcome } from "@/modules/attendance/outcome";

const record = {
  status: "LATE",
  lateMinutes: 30,
  checkInAt: new Date("2026-09-19T09:00:00Z"),
  checkOutAt: new Date("2026-09-19T17:30:00Z"),
  scheduledEndAt: new Date("2026-09-19T17:00:00Z"),
  overtimeMinutes: 30,
};

describe("canonical attendance outcome", () => {
  it.each([null, "PENDING", "REJECTED"] as const)(
    "continues penalized lateness for approval %s",
    (status) => {
      expect(
        attendanceOutcome({
          ...record,
          lateApproval: status
            ? { status, checkInAt: record.checkInAt, lateMinutes: 30 }
            : null,
        }),
      ).toMatchObject({
        status: "LATE",
        actualStatus: "LATE",
        actualLateMinutes: 30,
        effectiveLateMinutes: 30,
        isExcusedLate: false,
        lateApprovalStatus: status,
        rawOvertimeMinutes: 30,
        overtimeMinutes: 0,
      });
    },
  );

  it("excuses only effective lateness without mutating arrival or granting overtime", () => {
    const attendance = Object.freeze({
      ...record,
      lateApproval: {
        status: "APPROVED" as const,
        checkInAt: record.checkInAt,
        lateMinutes: 30,
      },
    });
    expect(attendanceOutcome(attendance)).toEqual({
      status: "PRESENT",
      actualStatus: "LATE",
      actualLateMinutes: 30,
      effectiveLateMinutes: 0,
      isExcusedLate: true,
      lateApprovalStatus: "APPROVED",
      rawOvertimeMinutes: 30,
      overtimeMinutes: 0,
    });
    expect(attendance.checkInAt.toISOString()).toBe("2026-09-19T09:00:00.000Z");
    expect(attendance.lateMinutes).toBe(30);
  });

  it("preserves half-day status even when lateness is excused", () => {
    expect(
      attendanceOutcome({
        ...record,
        status: "HALF_DAY",
        lateApproval: {
          status: "APPROVED",
          checkInAt: record.checkInAt,
          lateMinutes: 30,
        },
      }),
    ).toMatchObject({
      status: "HALF_DAY",
      effectiveLateMinutes: 0,
      isExcusedLate: true,
    });
  });

  it.each([
    { checkInAt: new Date("2026-09-19T09:01:00Z"), lateMinutes: 30 },
    { checkInAt: record.checkInAt, lateMinutes: 31 },
  ])("does not apply an approval to corrected attendance facts", (facts) => {
    expect(
      attendanceOutcome({
        ...record,
        ...facts,
        lateApproval: {
          status: "APPROVED",
          checkInAt: record.checkInAt,
          lateMinutes: 30,
        },
      }),
    ).toMatchObject({ status: "LATE", isExcusedLate: false });
  });

  it("preserves unknown overtime for legacy attendance without a schedule snapshot", () => {
    expect(
      attendanceOutcome({
        ...record,
        scheduledEndAt: null,
        overtimeMinutes: null,
      }),
    ).toMatchObject({ overtimeMinutes: null, rawOvertimeMinutes: null });
  });
});
