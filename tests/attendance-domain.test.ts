import { describe, expect, it } from "vitest";
import {
  calculateDistanceMeters,
  verifyGeofence,
} from "../src/modules/geofence/service";
import {
  calculateCheckIn,
  calculateCheckOut,
  getShiftWindow,
} from "../src/modules/shifts/calculations";
import { resolveAttendancePolicy } from "../src/modules/attendance/policy";

const office = {
  latitude: 23.8103,
  longitude: 90.4125,
  geofenceRadiusMeters: 100,
};
const shift = {
  startTime: "09:00",
  endTime: "18:00",
  timezone: "Asia/Dhaka",
  graceMinutes: 15,
  halfDayThreshold: 240,
};
describe("server-side geofencing", () => {
  it("returns zero distance for the same point", () =>
    expect(calculateDistanceMeters(0, 0, 0, 0)).toBe(0));
  it("measures known distance across the equator", () =>
    expect(calculateDistanceMeters(0, 0, 0, 1)).toBeCloseTo(111_194.93, 1));
  it("accepts inside geofence", () =>
    expect(
      verifyGeofence(
        {
          latitude: office.latitude,
          longitude: office.longitude,
          accuracy: 10,
        },
        office,
        50,
      ),
    ).toBe(0));
  it("rejects outside geofence", () =>
    expect(() =>
      verifyGeofence({ latitude: 24, longitude: 91, accuracy: 10 }, office, 50),
    ).toThrow("outside"));
  it("rejects poor accuracy and nonfinite coordinates", () => {
    expect(() =>
      verifyGeofence(
        {
          latitude: office.latitude,
          longitude: office.longitude,
          accuracy: 51,
        },
        office,
        50,
      ),
    ).toThrow("accurate");
    expect(() =>
      verifyGeofence(
        { latitude: NaN, longitude: 91, accuracy: 10 },
        office,
        50,
      ),
    ).toThrow("location");
  });
  it("rejects missing location", () =>
    expect(() => verifyGeofence(undefined, office, 50)).toThrow("location"));
});
describe("attendance calculations", () => {
  const startsAt = new Date("2026-09-19T03:00:00Z");
  it("includes the exact grace boundary", () =>
    expect(
      calculateCheckIn(new Date("2026-09-19T03:15:00Z"), startsAt, 15),
    ).toEqual({ status: "PRESENT", lateMinutes: 0 }));
  it("counts lateness from shift start after grace", () =>
    expect(
      calculateCheckIn(new Date("2026-09-19T03:15:01Z"), startsAt, 15),
    ).toEqual({ status: "LATE", lateMinutes: 16 }));
  it("allows early arrival", () =>
    expect(
      calculateCheckIn(new Date("2026-09-19T02:40:00Z"), startsAt, 15).status,
    ).toBe("PRESENT"));
  it("calculates worked minutes and half day", () => {
    expect(
      calculateCheckOut(
        startsAt,
        new Date("2026-09-19T06:59:59Z"),
        240,
        0,
        new Date("2026-09-19T12:00:00Z"),
      ),
    ).toEqual({ workedMinutes: 239, overtimeMinutes: 0, status: "HALF_DAY" });
    expect(
      calculateCheckOut(
        startsAt,
        new Date("2026-09-19T11:00:00Z"),
        240,
        20,
        new Date("2026-09-19T12:00:00Z"),
      ),
    ).toEqual({ workedMinutes: 480, overtimeMinutes: 0, status: "LATE" });
  });
  it.each([
    ["2026-09-19T11:59:00Z", 0],
    ["2026-09-19T12:00:00Z", 0],
    ["2026-09-19T12:00:59Z", 0],
    ["2026-09-19T12:00:59.999Z", 0],
    ["2026-09-19T12:01:00Z", 1],
    ["2026-09-19T12:59:59.999Z", 59],
    ["2026-09-19T13:00:00Z", 60],
    ["2026-09-19T13:01:00Z", 61],
    ["2026-09-19T13:30:59Z", 90],
  ])(
    "counts full overtime minutes at checkout %s",
    (checkout, overtimeMinutes) => {
      expect(
        calculateCheckOut(
          startsAt,
          new Date(checkout),
          240,
          0,
          new Date("2026-09-19T12:00:00Z"),
        ).overtimeMinutes,
      ).toBe(overtimeMinutes);
    },
  );
  it("does not count time before a late check-in as overtime", () => {
    expect(
      calculateCheckOut(
        new Date("2026-09-19T13:00:00Z"),
        new Date("2026-09-19T13:30:00Z"),
        240,
        600,
        new Date("2026-09-19T12:00:00Z"),
      ),
    ).toEqual({ workedMinutes: 30, overtimeMinutes: 30, status: "HALF_DAY" });
  });
  it.each([
    ["2026-09-19T13:31:29.499Z", 0],
    ["2026-09-19T13:31:29.500Z", 1],
    ["2026-09-19T14:30:29.499Z", 59],
    ["2026-09-19T14:30:29.500Z", 60],
  ])(
    "counts only complete elapsed minutes when check-in is after shift end: %s",
    (checkout, minutes) => {
      expect(
        calculateCheckOut(
          new Date("2026-09-19T13:30:29.500Z"),
          new Date(checkout),
          240,
          631,
          new Date("2026-09-19T12:00:00Z"),
        ),
      ).toEqual({
        workedMinutes: minutes,
        overtimeMinutes: minutes,
        status: "HALF_DAY",
      });
    },
  );
  it("keeps overtime unknown when the historical scheduled end is unavailable", () => {
    expect(
      calculateCheckOut(
        startsAt,
        new Date("2026-09-19T13:30:00Z"),
        240,
        0,
        null,
      ),
    ).toEqual({ workedMinutes: 630, overtimeMinutes: null, status: "PRESENT" });
  });
  it("does not subtract arrival lateness from time worked after shift end", () => {
    expect(
      calculateCheckOut(
        new Date("2026-09-19T04:00:00Z"),
        new Date("2026-09-19T13:30:00Z"),
        240,
        60,
        new Date("2026-09-19T12:00:00Z"),
      ),
    ).toEqual({ workedMinutes: 570, overtimeMinutes: 90, status: "LATE" });
  });
  it.each([
    ["09:30", "17:30", "2026-09-19T18:15:00+06:00"],
    ["15:30", "23:30", "2026-09-20T00:15:00+06:00"],
  ])(
    "counts overtime after a partial-hour Dhaka shift from %s to %s",
    (startTime, endTime, checkout) => {
      const checkOutAt = new Date(checkout);
      const window = getShiftWindow(
        checkOutAt,
        { ...shift, startTime, endTime },
        "2026-09-19",
      );
      expect(
        calculateCheckOut(window.startsAt, checkOutAt, 240, 0, window.endsAt),
      ).toEqual({ workedMinutes: 525, overtimeMinutes: 45, status: "PRESENT" });
    },
  );
  it("counts delayed overnight checkout on the original business date", () => {
    const nightShift = { ...shift, startTime: "22:00", endTime: "06:00" };
    const checkout = new Date("2026-09-20T01:30:00Z");
    const window = getShiftWindow(checkout, nightShift, "2026-09-19");
    expect(
      calculateCheckOut(window.startsAt, checkout, 240, 0, window.endsAt),
    ).toEqual({ workedMinutes: 570, overtimeMinutes: 90, status: "PRESENT" });
  });
  it("counts elapsed overtime correctly after a DST overnight shift", () => {
    const dstShift = {
      ...shift,
      startTime: "20:00",
      endTime: "05:00",
      timezone: "America/New_York",
    };
    const checkout = new Date("2026-03-08T10:30:00Z");
    const window = getShiftWindow(checkout, dstShift, "2026-03-07");
    expect(
      calculateCheckOut(window.startsAt, checkout, 240, 0, window.endsAt),
    ).toEqual({ workedMinutes: 570, overtimeMinutes: 90, status: "PRESENT" });
  });
  it("resolves local dates instead of UTC dates", () =>
    expect(
      getShiftWindow(
        new Date("2026-09-18T23:30:00Z"),
        shift,
      ).attendanceDate.toISOString(),
    ).toBe("2026-09-19T00:00:00.000Z"));
  it("assigns the after-midnight portion of overnight shift to its start date", () => {
    const window = getShiftWindow(new Date("2026-09-19T20:00:00Z"), {
      ...shift,
      startTime: "20:00",
      endTime: "05:00",
    });
    expect(window.attendanceDate.toISOString()).toBe(
      "2026-09-19T00:00:00.000Z",
    );
    expect(window.startsAt.toISOString()).toBe("2026-09-19T14:00:00.000Z");
    expect(window.endsAt.toISOString()).toBe("2026-09-19T23:00:00.000Z");
  });
  it("handles DST by constructing each local boundary separately", () => {
    const window = getShiftWindow(new Date("2026-03-07T23:00:00Z"), {
      ...shift,
      startTime: "20:00",
      endTime: "05:00",
      timezone: "America/New_York",
    });
    expect(
      (window.endsAt.getTime() - window.startsAt.getTime()) / 3_600_000,
    ).toBe(8);
  });
  it("uses strict policy defaults", () =>
    expect(resolveAttendancePolicy(null)).toEqual({
      requireWebAuthn: true,
      requireGeofence: true,
      requireOfficeNetwork: true,
      requireApprovedDevice: true,
      maximumGpsAccuracyMeters: 50,
    }));
});
