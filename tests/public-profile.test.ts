import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: { user: { findFirst: mocks.findUser } },
}));

import { getPublicProfile } from "@/modules/public-profile/service";

const publicUser = {
  profileSlug: "public_colleague",
  name: "Public colleague",
  image: "https://lh3.googleusercontent.com/profile-photo",
  designation: "Operations officer",
  phone: "+880 1700 123456",
  bloodGroup: "O+",
  publicDepartment: "Operations",
  homeAddress: "House 12, Dhaka",
  dateOfBirth: new Date("1995-01-15T00:00:00.000Z"),
};
const publicProfile = {
  slug: publicUser.profileSlug,
  name: publicUser.name,
  image: publicUser.image,
  designation: publicUser.designation,
  phone: publicUser.phone,
  bloodGroup: publicUser.bloodGroup,
  department: publicUser.publicDepartment,
  homeAddress: publicUser.homeAddress,
  dateOfBirth: "1995-01-15",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.findUser.mockResolvedValue(publicUser);
});

describe("public profile privacy boundary", () => {
  it("only queries public identity fields for an active account", async () => {
    await expect(getPublicProfile("public-user_1")).resolves.toEqual(
      publicProfile,
    );
    expect(mocks.findUser).toHaveBeenCalledExactlyOnceWith({
      where: {
        OR: [{ profileSlug: "public-user_1" }, { id: "public-user_1" }],
        status: "ACTIVE",
      },
      select: {
        profileSlug: true,
        name: true,
        image: true,
        designation: true,
        phone: true,
        bloodGroup: true,
        publicDepartment: true,
        homeAddress: true,
        dateOfBirth: true,
      },
    });
  });

  it("explicitly projects safe fields even if an unexpected query result includes private data", async () => {
    mocks.findUser.mockResolvedValue({
      ...publicUser,
      id: "private-user-id",
      email: "private-email@example.test",
      passwordHash: "private-password-hash",
      googleAccountId: "private-google-account",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
      sessions: [{ sessionToken: "private-session-token" }],
      accounts: [{ access_token: "private-access-token" }],
      employee: {
        id: "private-employee-id",
        employeeCode: "private-employee-code",
        joinedAt: new Date("2020-01-01"),
        department: { name: "private-internal-department" },
        office: {
          name: "private-office-name",
          address: "private-street-address",
          latitude: 23.123456,
          longitude: 90.123456,
        },
      },
    });

    const result = await getPublicProfile("public-user");
    expect(result).toEqual(publicProfile);
    expect(JSON.stringify(result)).not.toMatch(
      /private-|SUPER_ADMIN|23\.123456|90\.123456/,
    );
  });

  it("supports administrator accounts without an employee profile", async () => {
    mocks.findUser.mockResolvedValue({
      ...publicUser,
      name: "Public administrator",
      image: null,
      employee: null,
    });
    await expect(getPublicProfile("admin")).resolves.toEqual({
      ...publicProfile,
      name: "Public administrator",
      image: null,
    });
  });

  it("keeps missing public details empty instead of publishing internal employee fields", async () => {
    mocks.findUser.mockResolvedValue({
      ...publicUser,
      designation: null,
      phone: null,
      bloodGroup: null,
      publicDepartment: null,
      homeAddress: null,
      dateOfBirth: null,
      employee: {
        department: { name: "Private department" },
        office: { name: "Private office" },
      },
    });
    expect(await getPublicProfile("employee")).toEqual({
      slug: publicUser.profileSlug,
      name: publicUser.name,
      image: publicUser.image,
      designation: null,
      phone: null,
      bloodGroup: null,
      department: null,
      homeAddress: null,
      dateOfBirth: null,
    });
  });

  it("returns no profile when the active-account query finds no match", async () => {
    mocks.findUser.mockResolvedValue(null);
    await expect(getPublicProfile("unavailable")).resolves.toBeNull();
  });

  it.each([null, "", "   "])(
    "uses a neutral name, never an email fallback, for %j",
    async (name) => {
      mocks.findUser.mockResolvedValue({
        ...publicUser,
        name,
        email: "do-not-publish@example.test",
      });
      const result = await getPublicProfile("unnamed");
      expect(result?.name).toBe("Team member");
      expect(JSON.stringify(result)).not.toContain("do-not-publish");
    },
  );

  it.each([
    "",
    "contains spaces",
    "../admin",
    "user/email@example.test",
    "%2Fescaped",
    "user?admin=true",
    "user#fragment",
    "user\\path",
    "用户",
    "x".repeat(101),
  ])("rejects invalid user IDs before database work: %j", async (id) => {
    await expect(getPublicProfile(id)).resolves.toBeNull();
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it.each(["a", "A_Z-09", "x".repeat(100)])(
    "accepts a valid public route identifier: %s",
    async (id) => {
      await getPublicProfile(id);
      expect(mocks.findUser).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { OR: [{ profileSlug: id }, { id }], status: "ACTIVE" },
        }),
      );
    },
  );
});

describe("public profile image policy", () => {
  it.each([
    "/avatars/person.png",
    "/avatar.svg",
    "https://lh3.googleusercontent.com/photo=s96-c",
    "https://lh4.googleusercontent.com/photo",
    "https://lh5.googleusercontent.com/photo",
    "https://lh6.googleusercontent.com/photo",
  ])("allows supported profile image URL %s", async (image) => {
    mocks.findUser.mockResolvedValue({ ...publicUser, image });
    expect((await getPublicProfile("user"))?.image).toBe(image);
  });

  it.each([
    null,
    "",
    "javascript:alert(1)",
    "data:image/svg+xml,<svg/>",
    "http://lh3.googleusercontent.com/photo",
    "https://example.test/tracking-pixel",
    "https://lh3.googleusercontent.com.attacker.test/photo",
    "https://evil-lh3.googleusercontent.com/photo",
    "https://lh3.googleusercontent.com@attacker.test/photo",
    "https://user:secret@lh3.googleusercontent.com/photo",
    "https://lh3.googleusercontent.com:8080/photo",
    "//attacker.test/photo",
    "/\\attacker.test/photo",
    "\\\\attacker.test/photo",
    "relative/photo.png",
  ])("uses the fallback for unsupported image URL %j", async (image) => {
    mocks.findUser.mockResolvedValue({ ...publicUser, image });
    expect((await getPublicProfile("user"))?.image).toBeNull();
  });
});
