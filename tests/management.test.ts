import { describe, expect, it } from "vitest";
import { assertMayManageUser } from "@/modules/management/permissions";
import { calculateCorrection } from "@/modules/management/corrections";
import {
  assignmentSchema,
  dateSchema,
  employeeSchema,
  networkSchema,
  officeSchema,
  shiftSchema,
} from "@/modules/management/validation";

describe("management authorization and validation", () => {
  it("prevents administrator privilege escalation and editing elevated accounts", () => {
    expect(() =>
      assertMayManageUser(
        { id: "admin", role: "ADMIN" },
        { id: "employee", role: "EMPLOYEE" },
        { role: "SUPER_ADMIN" },
      ),
    ).toThrow();
    expect(() =>
      assertMayManageUser(
        { id: "admin", role: "ADMIN" },
        { id: "super", role: "SUPER_ADMIN" },
      ),
    ).toThrow();
    expect(() =>
      assertMayManageUser(
        { id: "employee", role: "EMPLOYEE" },
        { id: "other", role: "EMPLOYEE" },
      ),
    ).toThrow();
    expect(() =>
      assertMayManageUser(
        { id: "super", role: "SUPER_ADMIN" },
        { id: "super", role: "SUPER_ADMIN" },
        { status: "INACTIVE" },
      ),
    ).toThrow();
  });
  it("rejects impossible dates, reverse assignments, and unknown employee flags", () => {
    expect(dateSchema.safeParse("2025-02-30").success).toBe(false);
    expect(dateSchema.safeParse("2024-02-29").success).toBe(true);
    expect(
      assignmentSchema.safeParse({
        employeeId: "e",
        shiftId: "s",
        startDate: "2025-02-20",
        endDate: "2025-02-19",
      }).success,
    ).toBe(false);
    expect(
      employeeSchema.safeParse({
        name: "Employee",
        email: "employee@example.com",
        employeeCode: "E1",
        officeId: "o",
        role: "SUPER_ADMIN",
      }).success,
    ).toBe(false);
  });
  it("accepts IPv4/IPv6 CIDRs while rejecting malformed networks", () => {
    expect(
      networkSchema.safeParse({
        officeId: "o",
        publicIpOrCidr: "2001:db8::/64",
      }).success,
    ).toBe(true);
    expect(
      networkSchema.safeParse({ officeId: "o", publicIpOrCidr: "192.0.2.0/24" })
        .success,
    ).toBe(true);
    expect(
      networkSchema.safeParse({ officeId: "o", publicIpOrCidr: "192.0.2.0/33" })
        .success,
    ).toBe(false);
  });
  it("validates office timezone and overnight shift clocks", () => {
    expect(
      officeSchema.safeParse({
        name: "HQ",
        address: "Street",
        latitude: 0,
        longitude: 0,
        geofenceRadiusMeters: 100,
        timezone: "Invented/Timezone",
      }).success,
    ).toBe(false);
    expect(
      shiftSchema.safeParse({
        name: "Night",
        startTime: "20:00",
        endTime: "05:00",
        timezone: "Asia/Dhaka",
      }).success,
    ).toBe(true);
    expect(
      shiftSchema.safeParse({
        name: "Night",
        startTime: "09:00",
        endTime: "09:00",
        timezone: "UTC",
      }).success,
    ).toBe(false);
  });
});

describe("attendance corrections", () => {
  const previous = {
    attendanceDate: new Date("2025-01-06T00:00:00Z"),
    checkInAt: null,
    checkOutAt: null,
    shift: {
      startTime: "20:00",
      endTime: "05:00",
      timezone: "UTC",
      graceMinutes: 15,
      halfDayThreshold: 240,
    },
  };
  const now = new Date("2025-01-10T12:00:00Z");
  it("calculates overnight duration and late minutes from corrected evidence", () => {
    expect(
      calculateCorrection(
        previous,
        {
          reason: "Verified missed punches",
          checkInAt: "2025-01-06T20:30:00Z",
          checkOutAt: "2025-01-07T05:00:00Z",
        },
        now,
      ),
    ).toMatchObject({
      status: "LATE",
      lateMinutes: 30,
      workedMinutes: 510,
      overtimeMinutes: 0,
    });
  });
  it("recalculates overtime after an overnight checkout correction", () => {
    expect(
      calculateCorrection(
        previous,
        {
          reason: "Verified delayed checkout",
          checkInAt: "2025-01-06T20:00:00Z",
          checkOutAt: "2025-01-07T06:30:00Z",
        },
        now,
      ),
    ).toMatchObject({
      overtimeMinutes: 90,
      workedMinutes: 630,
      scheduledEndAt: new Date("2025-01-07T05:00:00Z"),
    });
  });
  it("preserves the original scheduled end after a Shift edit", () => {
    expect(
      calculateCorrection(
        {
          ...previous,
          shift: { ...previous.shift, endTime: "07:00" },
          scheduledEndAt: new Date("2025-01-07T05:00:00Z"),
        },
        {
          reason: "Verified delayed checkout",
          checkInAt: "2025-01-06T20:00:00Z",
          checkOutAt: "2025-01-07T06:30:00Z",
        },
        now,
      ),
    ).toMatchObject({
      overtimeMinutes: 90,
      scheduledEndAt: new Date("2025-01-07T05:00:00Z"),
    });
  });
  it("clears overtime when an administrator removes checkout", () => {
    expect(
      calculateCorrection(
        {
          ...previous,
          checkInAt: new Date("2025-01-06T20:00:00Z"),
          checkOutAt: new Date("2025-01-07T06:30:00Z"),
          scheduledEndAt: new Date("2025-01-07T05:00:00Z"),
        },
        { reason: "Reopen attendance", checkOutAt: null },
        now,
      ),
    ).toMatchObject({ overtimeMinutes: 0, workedMinutes: 0, checkOutAt: null });
  });
  it.each([
    { reason: "Verified status", status: "PRESENT" as const },
    { reason: "Verified checkout", checkOutAt: "2025-01-07T07:00:00Z" },
  ])(
    "preserves unknown overtime when correcting a completed legacy row",
    (input) => {
      expect(
        calculateCorrection(
          {
            ...previous,
            checkInAt: new Date("2025-01-06T20:00:00Z"),
            checkOutAt: new Date("2025-01-07T06:30:00Z"),
            scheduledEndAt: null,
          },
          input,
          now,
        ),
      ).toMatchObject({ scheduledEndAt: null, overtimeMinutes: null });
    },
  );
  it("rejects invalid chronology, unrelated dates, future punches, and contradictory status", () => {
    expect(() =>
      calculateCorrection(
        previous,
        {
          reason: "Verified missed punches",
          checkOutAt: "2025-01-07T05:00:00Z",
        },
        now,
      ),
    ).toThrow();
    expect(() =>
      calculateCorrection(
        previous,
        {
          reason: "Verified missed punches",
          checkInAt: "2025-01-03T20:00:00Z",
        },
        now,
      ),
    ).toThrow();
    expect(() =>
      calculateCorrection(
        previous,
        {
          reason: "Verified missed punches",
          checkInAt: "2025-01-11T20:00:00Z",
        },
        now,
      ),
    ).toThrow();
    expect(() =>
      calculateCorrection(
        previous,
        {
          reason: "Verified missed punches",
          checkInAt: "2025-01-06T20:00:00Z",
          status: "ABSENT",
        },
        now,
      ),
    ).toThrow();
  });
});
