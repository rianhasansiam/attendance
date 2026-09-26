import { describe, expect, it } from "vitest";
import {
  attendanceIntent,
  recoveredAttendance,
} from "@/lib/client/attendance-recovery";
import type {
  AttendanceRecord,
  EmployeeDay,
} from "@/store/features/attendance/contracts";

const arrived: AttendanceRecord = {
  id: "attendance-one",
  attendanceDate: "2026-09-24T00:00:00.000Z",
  checkInAt: "2026-09-24T22:00:00.000Z",
  checkOutAt: null,
  status: "PRESENT",
  lateMinutes: 0,
  lateReason: null,
  workedMinutes: 0,
  overtimeMinutes: 0,
};
const observedServerTime = "2026-09-25T05:59:00.000Z";
function day(patch: Partial<EmployeeDay> = {}): EmployeeDay {
  return {
    employee: {
      id: "employee-one",
      employeeCode: "ONE",
      user: { name: "Employee", email: "employee@example.test", image: null },
      department: null,
      office: {
        id: "office-one",
        name: "Office",
        address: "Office address",
        timezone: "UTC",
        policy: { requireGeofence: true, requireOfficeNetwork: true },
      },
    },
    shift: null,
    today: arrived,
    recent: [],
    devices: [],
    network: { verified: true },
    serverTime: observedServerTime,
    ...patch,
  };
}
const completed: AttendanceRecord = {
  ...arrived,
  checkOutAt: "2026-09-25T06:00:00.000Z",
  workedMinutes: 480,
};

describe("attendance recovery intent", () => {
  it("records the original attendance and known arrivals from today and recent", () => {
    const previous = {
      ...arrived,
      id: "previous",
      checkInAt: "2026-09-23T22:00:00.000Z",
    };
    const missingArrival = { ...arrived, id: "empty", checkInAt: null };
    const missingId = { ...arrived, id: undefined };
    const intent = attendanceIntent(
      "CHECK_OUT",
      day({ recent: [previous, missingArrival, missingId] }),
    );
    expect(intent).toEqual({
      action: "CHECK_OUT",
      employeeId: "employee-one",
      before: arrived,
      knownArrivals: [
        `${arrived.id}:${arrived.checkInAt}`,
        `${previous.id}:${previous.checkInAt}`,
      ],
      observedServerTime,
    });
  });
});

describe("checkout recovery", () => {
  it("accepts the original record only after an actual checkout", () => {
    const intent = attendanceIntent("CHECK_OUT", day());
    expect(recoveredAttendance(day(), intent)).toBeUndefined();
    expect(recoveredAttendance(day({ today: completed }), intent)).toBe(
      completed,
    );
  });

  it("finds an overnight checkout in recent when today has advanced", () => {
    const intent = attendanceIntent("CHECK_OUT", day());
    const followingDay = {
      ...arrived,
      id: "attendance-two",
      attendanceDate: "2026-09-25T00:00:00.000Z",
      checkInAt: "2026-09-25T22:00:00.000Z",
    };
    expect(
      recoveredAttendance(
        day({ today: followingDay, recent: [completed] }),
        intent,
      ),
    ).toBe(completed);
  });

  it.each([
    { id: "another-record" },
    { attendanceDate: "2026-09-25T00:00:00.000Z" },
    { checkInAt: "2026-09-24T21:00:00.000Z" },
    { checkInAt: null },
    { checkOutAt: null },
    { id: undefined },
  ])("rejects a different or incomplete transition %j", (patch) => {
    const intent = attendanceIntent("CHECK_OUT", day());
    expect(
      recoveredAttendance(day({ today: { ...completed, ...patch } }), intent),
    ).toBeUndefined();
  });

  it("rejects another employee's otherwise matching record", () => {
    const intent = attendanceIntent("CHECK_OUT", day());
    expect(
      recoveredAttendance(
        day({
          today: completed,
          employee: { ...day().employee, id: "another-employee" },
        }),
        intent,
      ),
    ).toBeUndefined();
  });

  it("does not interpret a previously completed checkout as a new success", () => {
    const intent = attendanceIntent("CHECK_OUT", day({ today: completed }));
    expect(
      recoveredAttendance(day({ today: completed }), intent),
    ).toBeUndefined();
  });

  it.each([
    "invalidtime",
    "2026-09-25T05:58:59.999Z",
    "2026-09-24T21:00:00.000Z",
  ])("rejects an invalid or earlier checkout timestamp %s", (checkOutAt) => {
    const intent = attendanceIntent("CHECK_OUT", day());
    expect(
      recoveredAttendance(day({ today: { ...completed, checkOutAt } }), intent),
    ).toBeUndefined();
  });

  it("cannot recover checkout without the original check-in record", () => {
    const intent = attendanceIntent("CHECK_OUT", day({ today: null }));
    expect(
      recoveredAttendance(day({ today: completed }), intent),
    ).toBeUndefined();
  });
});

describe("check-in recovery", () => {
  const newArrival: AttendanceRecord = {
    ...arrived,
    id: "new-attendance",
    attendanceDate: "2026-09-25T00:00:00.000Z",
    checkInAt: "2026-09-25T06:00:00.000Z",
  };

  it("accepts a newly observed arrival after the pre-attempt server time", () => {
    const intent = attendanceIntent("CHECK_IN", day({ today: null }));
    expect(recoveredAttendance(day({ today: newArrival }), intent)).toBe(
      newArrival,
    );
  });

  it("accepts a new arrival exactly at the observed server time", () => {
    const intent = attendanceIntent("CHECK_IN", day({ today: null }));
    const sameMillisecond = { ...newArrival, checkInAt: observedServerTime };
    expect(recoveredAttendance(day({ today: sameMillisecond }), intent)).toBe(
      sameMillisecond,
    );
  });

  it("finds the new arrival in recent when the workday has advanced", () => {
    const intent = attendanceIntent("CHECK_IN", day({ today: null }));
    expect(
      recoveredAttendance(day({ today: null, recent: [newArrival] }), intent),
    ).toBe(newArrival);
  });

  it.each(["today", "recent"] as const)(
    "does not accept an arrival already known in %s",
    (where) => {
      const before =
        where === "today"
          ? day({ today: newArrival })
          : day({ today: null, recent: [newArrival] });
      const intent = attendanceIntent("CHECK_IN", before);
      expect(
        recoveredAttendance(day({ today: newArrival }), intent),
      ).toBeUndefined();
    },
  );

  it.each([
    { checkInAt: "2026-09-25T05:58:59.999Z" },
    { checkInAt: "invalidtime" },
    { checkInAt: null },
    { id: undefined },
  ])("rejects an old, invalid or incomplete arrival %j", (patch) => {
    const intent = attendanceIntent("CHECK_IN", day({ today: null }));
    expect(
      recoveredAttendance(day({ today: { ...newArrival, ...patch } }), intent),
    ).toBeUndefined();
  });

  it("rejects arrivals when the observed server timestamp is invalid", () => {
    const intent = attendanceIntent(
      "CHECK_IN",
      day({ today: null, serverTime: "invalidtime" }),
    );
    expect(
      recoveredAttendance(day({ today: newArrival }), intent),
    ).toBeUndefined();
  });

  it("rejects another employee's new arrival", () => {
    const intent = attendanceIntent("CHECK_IN", day({ today: null }));
    expect(
      recoveredAttendance(
        day({
          today: newArrival,
          employee: { ...day().employee, id: "another-employee" },
        }),
        intent,
      ),
    ).toBeUndefined();
  });
});
