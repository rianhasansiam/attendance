import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmployeeActor } from "../src/modules/webauthn/service";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  lock: vi.fn(),
  employee: vi.fn(),
  session: vi.fn(),
  attendance: vi.fn(),
  update: vi.fn(),
  event: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
import {
  lateReasonSchema,
  saveLateReason,
} from "../src/modules/attendance/service";

const actor = {
  id: "user",
  googleAccountId: "google-account",
  sessionId: "session",
  employee: { id: "employee" },
} as EmployeeActor;
const record = {
  id: "attendance",
  attendanceDate: new Date("2026-09-20T00:00:00Z"),
  checkInAt: new Date("2026-09-20T09:20:00Z"),
  checkOutAt: null,
  status: "LATE",
  lateMinutes: 20,
  lateReason: null,
  workedMinutes: 0,
};
const input = { attendanceId: record.id, reason: "  Train delayed.  " };
const tx = {
  $queryRaw: mocks.lock,
  employee: { findUnique: mocks.employee },
  session: { findFirst: mocks.session },
  attendance: { findFirst: mocks.attendance, update: mocks.update },
  attendanceEvent: { create: mocks.event },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation((run) => run(tx));
  mocks.employee.mockResolvedValue({
    id: "employee",
    user: { id: "user", status: "ACTIVE", googleAccountId: "google-account" },
  });
  mocks.session.mockResolvedValue({ id: "session" });
  mocks.attendance.mockResolvedValue(record);
  mocks.update.mockResolvedValue({ ...record, lateReason: "Train delayed." });
});

describe("late attendance reason validation", () => {
  it("trims the reason and accepts the maximum length", () => {
    expect(lateReasonSchema.parse(input).reason).toBe("Train delayed.");
    expect(
      lateReasonSchema.parse({
        attendanceId: "attendance",
        reason: "a".repeat(1000),
      }).reason,
    ).toHaveLength(1000);
  });

  it.each([undefined, null, "", " \n\t ", 123, "a".repeat(1001)])(
    "rejects missing or invalid reason %j",
    async (reason) => {
      await expect(
        saveLateReason(actor, { ...input, reason } as typeof input),
      ).rejects.toMatchObject({ name: "ZodError" });
      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown fields and missing attendance IDs", () => {
    expect(
      lateReasonSchema.safeParse({ ...input, employeeId: "other" }).success,
    ).toBe(false);
    expect(lateReasonSchema.safeParse({ reason: "Delayed." }).success).toBe(
      false,
    );
  });
});

describe("late attendance reason persistence", () => {
  it("saves a trimmed reason and audit event together after locking and checking authorization", async () => {
    await expect(saveLateReason(actor, input)).resolves.toEqual({
      ...record,
      lateReason: "Train delayed.",
    });
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
      timeout: 15_000,
    });
    expect(mocks.lock.mock.calls[0][1]).toBe("employee");
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.employee.mock.invocationCallOrder[0],
    );
    expect(mocks.attendance).toHaveBeenCalledWith({
      where: { id: "attendance", employeeId: "employee" },
      select: expect.objectContaining({ lateReason: true }),
    });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "attendance" },
      data: { lateReason: "Train delayed." },
      select: expect.objectContaining({ lateReason: true }),
    });
    expect(mocks.event).toHaveBeenCalledExactlyOnceWith({
      data: {
        employeeId: "employee",
        attendanceId: "attendance",
        type: "LATE_REASON_SUBMITTED",
      },
    });
  });

  it("returns not found when the requested record is not owned by the employee", async () => {
    mocks.attendance.mockResolvedValue(null);
    await expect(saveLateReason(actor, input)).rejects.toMatchObject({
      code: "ATTENDANCE_NOT_FOUND",
      status: 404,
    });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.event).not.toHaveBeenCalled();
  });

  it.each([{ lateMinutes: 0 }, { checkInAt: null }])(
    "rejects attendance that does not represent a late check-in: %j",
    async (change) => {
      mocks.attendance.mockResolvedValue({ ...record, ...change });
      await expect(saveLateReason(actor, input)).rejects.toMatchObject({
        code: "ATTENDANCE_NOT_LATE",
      });
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );

  it("accepts late check-ins whose checkout status changed to HALF_DAY", async () => {
    mocks.attendance.mockResolvedValue({ ...record, status: "HALF_DAY" });
    await saveLateReason(actor, input);
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it("accepts an identical retry without another update or audit event", async () => {
    mocks.attendance.mockResolvedValue({
      ...record,
      lateReason: "Train delayed.",
    });
    await expect(saveLateReason(actor, input)).resolves.toMatchObject({
      lateReason: "Train delayed.",
    });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.event).not.toHaveBeenCalled();
  });

  it("preserves a previously submitted reason", async () => {
    mocks.attendance.mockResolvedValue({ ...record, lateReason: "Traffic." });
    await expect(saveLateReason(actor, input)).rejects.toMatchObject({
      code: "LATE_REASON_ALREADY_SUBMITTED",
      status: 409,
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rechecks session expiry before reading or updating attendance", async () => {
    mocks.session.mockResolvedValue(null);
    await expect(saveLateReason(actor, input)).rejects.toMatchObject({
      code: "USER_NOT_AUTHORIZED",
      status: 403,
    });
    expect(mocks.session).toHaveBeenCalledWith({
      where: {
        id: "session",
        userId: "user",
        expires: { gt: expect.any(Date) },
      },
      select: { id: true },
    });
    expect(mocks.attendance).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([
    [
      { id: "user", status: "INACTIVE", googleAccountId: "google-account" },
      "USER_INACTIVE",
    ],
    [
      { id: "other", status: "ACTIVE", googleAccountId: "google-account" },
      "USER_NOT_AUTHORIZED",
    ],
    [
      { id: "user", status: "ACTIVE", googleAccountId: "changed" },
      "USER_NOT_AUTHORIZED",
    ],
  ])("rejects changed employee authorization %j", async (user, code) => {
    mocks.employee.mockResolvedValue({ id: "employee", user });
    await expect(saveLateReason(actor, input)).rejects.toMatchObject({
      code,
      status: 403,
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not report success if the transactional audit write fails", async () => {
    mocks.event.mockRejectedValue(new Error("Audit write failed"));
    await expect(saveLateReason(actor, input)).rejects.toThrow(
      "Audit write failed",
    );
  });
});
