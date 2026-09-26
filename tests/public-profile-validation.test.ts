import { describe, expect, it } from "vitest";
import {
  bloodGroups,
  publicProfileUpdateSchema,
} from "@/modules/public-profile/validation";
import {
  employeeUpdateSchema,
  userUpdateSchema,
} from "@/modules/management/validation";

describe("public profile validation", () => {
  it("normalizes optional fields without requiring invented personal information", () => {
    expect(
      publicProfileUpdateSchema.parse({
        name: "  Team member  ",
        designation: " ",
        phone: "  +880 1700 123456  ",
        bloodGroup: "",
        publicDepartment: null,
        homeAddress: "   ",
        dateOfBirth: "",
      }),
    ).toEqual({
      name: "Team member",
      designation: null,
      phone: "+880 1700 123456",
      bloodGroup: null,
      publicDepartment: null,
      homeAddress: null,
      dateOfBirth: null,
    });
  });

  it.each(bloodGroups)("accepts blood group %s", (bloodGroup) => {
    expect(
      publicProfileUpdateSchema.parse({ name: "Name", bloodGroup }).bloodGroup,
    ).toBe(bloodGroup);
  });

  it.each([
    { name: " " },
    { name: "x".repeat(161) },
    { designation: "x".repeat(161) },
    { phone: "x".repeat(41) },
    { publicDepartment: "x".repeat(161) },
    { homeAddress: "x".repeat(1001) },
    { bloodGroup: "Unknown" },
    { dateOfBirth: "2025-02-29" },
    { dateOfBirth: "2024-04-31" },
    { dateOfBirth: "0000-01-01" },
    { dateOfBirth: "9999-01-01" },
    { dateOfBirth: "01/01/2000" },
    { dateOfBirth: "2000-01-01T00:00:00Z" },
    { role: "SUPER_ADMIN" },
    { status: "ACTIVE" },
    { email: "other@example.test" },
    { passwordHash: "changed" },
  ])("rejects invalid or unrelated field %j", (invalid) => {
    expect(
      publicProfileUpdateSchema.safeParse({ name: "Name", ...invalid }).success,
    ).toBe(false);
  });

  it("preserves a real leap-day as a date-only string", () => {
    expect(
      publicProfileUpdateSchema.parse({
        name: "Name",
        dateOfBirth: "2000-02-29",
      }).dateOfBirth,
    ).toBe("2000-02-29");
  });

  it.each([
    ["designation", "Engineer"],
    ["phone", "+8801700123456"],
    ["bloodGroup", "O+"],
    ["publicDepartment", "Operations"],
    ["homeAddress", "Dhaka"],
    ["dateOfBirth", "2000-01-01"],
  ])(
    "does not permit the general employee/user editor to write %s",
    (key, value) => {
      expect(employeeUpdateSchema.safeParse({ [key]: value }).success).toBe(
        false,
      );
      expect(userUpdateSchema.safeParse({ [key]: value }).success).toBe(false);
    },
  );
});
