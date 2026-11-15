import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateEligibleOvertime,
  countedOvertimeMinutes,
  MINIMUM_ELIGIBLE_OVERTIME_MINUTES,
} from "../src/modules/attendance/overtime-policy";
import {
  attendanceOutcome,
  overtimeRequestMatchesAttendance,
} from "../src/modules/attendance/outcome";
import { getShiftWindow } from "../src/modules/shifts/calculations";

const checkInAt = new Date("2026-11-12T08:30:00Z");
const scheduledEndAt = new Date("2026-11-12T17:00:00Z");
const checkout = (minutes: number) =>
  new Date(scheduledEndAt.getTime() + minutes * 60_000);
const facts = {
  status: "PRESENT",
  lateMinutes: 0,
  checkInAt,
  checkOutAt: checkout(75),
  scheduledEndAt,
  overtimeMinutes: 75,
};
const request = {
  id: "request-1",
  status: "APPROVED" as const,
  checkInAt,
  checkOutAt: facts.checkOutAt,
  scheduledEndAt,
  requestedMinutes: 75,
  updatedAt: new Date("2026-11-12T19:00:00Z"),
};

for (const minutes of [0, 1, 29, 30, 45, 59, 60, 61, 75, 120]) {
  test(`${minutes} minutes: eligibility starts at 60 and approval credits full duration`, () => {
    const actual = calculateEligibleOvertime(
      checkInAt,
      checkout(minutes),
      scheduledEndAt,
    );
    assert.equal(actual, minutes);
    const result = attendanceOutcome({
      ...facts,
      checkOutAt: checkout(minutes),
      overtimeRequest: {
        ...request,
        checkOutAt: checkout(minutes),
        requestedMinutes: minutes,
      },
    });
    assert.equal(
      result.approvedOvertimeMinutes,
      minutes >= MINIMUM_ELIGIBLE_OVERTIME_MINUTES ? minutes : 0,
    );
  });
}

test("59m59s is ineligible; exactly 60 completed minutes qualifies", () => {
  assert.equal(
    calculateEligibleOvertime(
      checkInAt,
      new Date(checkout(60).getTime() - 1),
      scheduledEndAt,
    ),
    59,
  );
  assert.equal(
    calculateEligibleOvertime(checkInAt, checkout(60), scheduledEndAt),
    60,
  );
});

for (const status of ["PENDING", "APPROVED", "REJECTED"] as const) {
  test(`${status} retains requested minutes and credits only an approved request`, () => {
    const result = attendanceOutcome({
      ...facts,
      overtimeRequest: { ...request, status },
    });
    assert.equal(result.requestedOvertimeMinutes, 75);
    assert.equal(result.overtimeRequestStatus, status);
    assert.equal(
      result.approvedOvertimeMinutes,
      status === "APPROVED" ? 75 : 0,
    );
  });
}

test("historical positive and unknown balances never earn automatic credit", () => {
  for (const overtimeMinutes of [null, 30, 75, 120]) {
    const result = attendanceOutcome({
      ...facts,
      overtimeMinutes,
      scheduledEndAt: null,
    });
    assert.equal(result.overtimeMinutes, overtimeMinutes);
    assert.equal(result.approvedOvertimeMinutes, 0);
    assert.equal(result.requestedOvertimeMinutes, null);
  }
});

test("approved credit uses full after-end work without the former lateness offset", () => {
  const result = attendanceOutcome({
    ...facts,
    lateMinutes: 30,
    overtimeMinutes: 45,
    overtimeRequest: request,
  });
  assert.equal(result.overtimeMinutes, 45);
  assert.equal(result.approvedOvertimeMinutes, 75);
});

test("existing lateness and completed-workday deductions remain separate", () => {
  assert.equal(
    countedOvertimeMinutes({
      approvedOvertimeMinutes: 75,
      lateMinutes: 6,
      completedWorkedMinutes: 480,
    }),
    15,
  );
  assert.equal(
    countedOvertimeMinutes({
      approvedOvertimeMinutes: 75,
      lateMinutes: 5,
      completedWorkedMinutes: 510,
    }),
    75,
  );
  assert.equal(
    countedOvertimeMinutes({
      approvedOvertimeMinutes: 0,
      lateMinutes: 6,
      completedWorkedMinutes: 480,
    }),
    -60,
  );
  assert.equal(
    countedOvertimeMinutes({ approvedOvertimeMinutes: 0, lateMinutes: 6 }),
    -30,
  );
});

test("a correction invalidates credit without changing historical request status", () => {
  for (const changed of [
    { checkInAt: new Date(checkInAt.getTime() + 1) },
    { checkOutAt: checkout(76) },
    { scheduledEndAt: new Date(scheduledEndAt.getTime() + 1) },
    { checkOutAt: null },
  ]) {
    const corrected = { ...facts, ...changed };
    assert.equal(overtimeRequestMatchesAttendance(corrected, request), false);
    const result = attendanceOutcome({
      ...corrected,
      overtimeRequest: request,
    });
    assert.equal(result.overtimeRequestStatus, "APPROVED");
    assert.equal(result.approvedOvertimeMinutes, 0);
  }
  assert.equal(
    attendanceOutcome({ ...facts, overtimeRequest: request })
      .approvedOvertimeMinutes,
    75,
  );
});

test("overnight snapshots and late arrivals after duty end cap actual extra work", () => {
  const window = getShiftWindow(
    new Date("2026-11-12T22:00:00Z"),
    {
      startTime: "22:00",
      endTime: "06:00",
      timezone: "Asia/Dhaka",
      graceMinutes: 15,
      halfDayThreshold: 240,
    },
    "2026-11-12",
  );
  assert.equal(window.endsAt.toISOString(), "2026-11-13T00:00:00.000Z");
  assert.equal(
    calculateEligibleOvertime(
      new Date("2026-11-12T16:00:00Z"),
      new Date("2026-11-13T01:15:00Z"),
      window.endsAt,
    ),
    75,
  );
  assert.equal(
    calculateEligibleOvertime(checkout(90), checkout(120), scheduledEndAt),
    30,
  );
  assert.equal(
    calculateEligibleOvertime(checkInAt, checkout(-5), scheduledEndAt),
    0,
  );
  assert.equal(calculateEligibleOvertime(checkInAt, checkout(75), null), null);
  assert.equal(
    calculateEligibleOvertime(checkInAt, new Date("invalid"), scheduledEndAt),
    null,
  );
});
