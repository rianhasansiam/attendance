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
      calculateCheckOut(startsAt, new Date("2026-09-19T06:59:59Z"), 240, 0),
    ).toEqual({ workedMinutes: 239, status: "HALF_DAY" });
    expect(
      calculateCheckOut(startsAt, new Date("2026-09-19T11:00:00Z"), 240, 20),
    ).toEqual({ workedMinutes: 480, status: "LATE" });
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
