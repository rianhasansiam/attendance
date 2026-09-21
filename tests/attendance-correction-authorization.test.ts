import type { Role, UserStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/modules/management/permissions";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  currentUser: vi.fn(),
  findAttendance: vi.fn(),
  updateAttendance: vi.fn(),
  createAttendance: vi.fn(),
  findEmployee: vi.fn(),
  createEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));

import {
  correctAttendance,
  createAttendanceCorrection,
} from "@/modules/management/workflows";

const tx = {
  user: { findUnique: mocks.currentUser },
  attendance: {
    findUnique: mocks.findAttendance,
    update: mocks.updateAttendance,
    create: mocks.createAttendance,
  },
  employee: { findUnique: mocks.findEmployee },
  attendanceEvent: { create: mocks.createEvent },
};
const input = { reason: "Verified attendance correction" };
const corrections: [string, (actor: Actor) => Promise<unknown>][] = [
  ["existing attendance", (actor) => correctAttendance(actor, "record", input)],
  [
    "derived attendance",
    (actor) =>
      createAttendanceCorrection(actor, {
        ...input,
        employeeId: "employee",
        attendanceDate: "2025-01-06",
      }),
  ],
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (work) => work(tx));
});

describe.each(corrections)("%s correction authorization", (_name, correct) => {
  it.each(["EMPLOYEE", "ADMIN"] as const)(
    "rejects %s actors before database work",
    async (role) => {
      await expect(correct({ id: "actor", role })).rejects.toMatchObject({
        code: "FORBIDDEN",
        status: 403,
      });
      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );

  it.each<{
    name: string;
    user: { id: string; role: Role; status: UserStatus } | null;
  }>([
    {
      name: "demoted administrator",
      user: { id: "actor", role: "ADMIN", status: "ACTIVE" },
    },
    {
      name: "demoted employee",
      user: { id: "actor", role: "EMPLOYEE", status: "ACTIVE" },
    },
    {
      name: "inactive super administrator",
      user: { id: "actor", role: "SUPER_ADMIN", status: "INACTIVE" },
    },
    {
      name: "suspended super administrator",
      user: { id: "actor", role: "SUPER_ADMIN", status: "SUSPENDED" },
    },
    { name: "deleted user", user: null },
  ])(
    "rejects a stale super administrator actor for $name",
    async ({ user }) => {
      mocks.currentUser.mockResolvedValue(user);
      await expect(
        correct({ id: "actor", role: "SUPER_ADMIN" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
      expect(mocks.currentUser).toHaveBeenCalledWith({
        where: { id: "actor" },
        select: { id: true, role: true, status: true },
      });
      expect(mocks.findAttendance).not.toHaveBeenCalled();
      expect(mocks.findEmployee).not.toHaveBeenCalled();
      expect(mocks.updateAttendance).not.toHaveBeenCalled();
      expect(mocks.createAttendance).not.toHaveBeenCalled();
      expect(mocks.createEvent).not.toHaveBeenCalled();
    },
  );
});
