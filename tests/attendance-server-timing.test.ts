import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmployeeActor } from "../src/modules/webauthn/service";
import { DomainError } from "../src/lib/errors";
import { ServerTiming } from "../src/lib/server-timing";

const mocks = vi.hoisted(() => ({
  office: vi.fn(),
  transaction: vi.fn(),
  lock: vi.fn(),
  employee: vi.fn(),
  session: vi.fn(),
  openAttendance: vi.fn(),
  existingAttendance: vi.fn(),
  create: vi.fn(),
  event: vi.fn(),
  rejection: vi.fn(),
  consumeChallenge: vi.fn(),
  verifyAssertion: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    office: { findUniqueOrThrow: mocks.office },
    $transaction: mocks.transaction,
    attendanceEvent: { create: mocks.rejection },
  },
}));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ TRUSTED_PROXY_MODE: "none" }),
}));
vi.mock("@/modules/webauthn/service", () => ({
  consumeChallenge: mocks.consumeChallenge,
  verifyAttendanceAssertion: mocks.verifyAssertion,
  deviceSelect: {},
}));
import { recordAttendance } from "../src/modules/attendance/service";

const actor = {
  id: "user",
  googleAccountId: "google",
  sessionId: "session",
  employee: { id: "employee", officeId: "office" },
} as EmployeeActor;
const office = {
  active: true,
  requireWebAuthn: true,
  requireGeofence: false,
  requireOfficeNetwork: false,
  requireApprovedDevice: true,
};
const employee = {
  id: "employee",
  officeId: "office",
  office,
  user: { status: "ACTIVE", googleAccountId: "google" },
  shifts: [
    {
      startDate: new Date("2000-01-01"),
      endDate: null,
      shift: {
        id: "shift",
        active: true,
        startTime: "09:00",
        endTime: "18:00",
        timezone: "UTC",
        graceMinutes: 15,
        halfDayThreshold: 240,
      },
    },
  ],
};
const evidence = {
  challengeId: "challenge-id",
  response: {
    id: "credential",
    rawId: "credential",
    type: "public-key" as const,
    clientExtensionResults: {},
    response: {
      clientDataJSON: "client",
      authenticatorData: "authenticator",
      signature: "signature",
    },
  },
};
const tx = {
  $queryRaw: mocks.lock,
  employee: { findUniqueOrThrow: mocks.employee },
  session: { findFirst: mocks.session },
  attendance: {
    findFirst: mocks.openAttendance,
    findUnique: mocks.existingAttendance,
    create: mocks.create,
  },
  attendanceEvent: { create: mocks.event },
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.office.mockResolvedValue(office);
  mocks.employee.mockResolvedValue(employee);
  mocks.session.mockResolvedValue({ id: "session" });
  mocks.openAttendance.mockResolvedValue(null);
  mocks.existingAttendance.mockResolvedValue(null);
  mocks.consumeChallenge.mockResolvedValue("consumed-challenge");
  mocks.verifyAssertion.mockResolvedValue("credential-id");
  mocks.create.mockImplementation(async ({ data }) => ({
    id: "attendance",
    checkOutAt: null,
    lateReason: null,
    workedMinutes: 0,
    ...data,
  }));
  mocks.transaction.mockImplementation((run) => run(tx));
});

describe("timed attendance transaction boundaries", () => {
  it("does not return confirmed attendance until the transaction commits", async () => {
    const callbackFinished = deferred();
    const commit = deferred();
    mocks.transaction.mockImplementation(async (run) => {
      const record = await run(tx);
      callbackFinished.resolve();
      await commit.promise;
      return record;
    });
    const timing = new ServerTiming();
    let resolved = false;
    const pending = recordAttendance(
      actor,
      "CHECK_IN",
      evidence,
      new Headers(),
      timing,
    ).then((record) => {
      resolved = true;
      return record;
    });
    await callbackFinished.promise;
    expect(resolved).toBe(false);
    expect(mocks.event).toHaveBeenCalledOnce();
    expect(mocks.rejection).not.toHaveBeenCalled();
    expect(mocks.transaction.mock.calls[0][1]).toEqual({
      isolationLevel: "Serializable",
      timeout: 15_000,
    });
    commit.resolve();
    const record = await pending;
    expect(record).toMatchObject({
      id: "attendance",
      checkInAt: expect.any(Date),
    });
    expect(record).not.toHaveProperty("checkInCredentialId");
    const header = timing.apply(new Response()).headers.get("Server-Timing")!;
    for (const phase of [
      "initial_policy",
      "challenge",
      "tx_acquire",
      "employee_lock",
      "authoritative_reads",
      "verification",
      "db_write",
      "tx_finish",
      "transaction",
      "total",
    ])
      expect(header).toContain(`${phase};dur=`);
    expect(header).not.toMatch(
      /employee-id|credential-id|consumed-challenge|signature/,
    );
  });

  it("keeps challenge consumption outside the transaction and preserves rejection logging", async () => {
    const failure = new DomainError("WEBAUTHN_FAILED", "Verification failed.");
    mocks.verifyAssertion.mockRejectedValue(failure);
    const timing = new ServerTiming();
    await expect(
      recordAttendance(actor, "CHECK_IN", evidence, new Headers(), timing),
    ).rejects.toBe(failure);
    expect(mocks.consumeChallenge).toHaveBeenCalledExactlyOnceWith(
      actor,
      "CHECK_IN",
      "challenge-id",
    );
    expect(mocks.consumeChallenge.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.transaction.mock.invocationCallOrder[0],
    );
    expect(mocks.lock).toHaveBeenCalledOnce();
    expect(mocks.verifyAssertion).toHaveBeenCalledExactlyOnceWith(
      tx,
      actor,
      evidence.response,
      "consumed-challenge",
      true,
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.event).not.toHaveBeenCalled();
    expect(mocks.rejection).toHaveBeenCalledExactlyOnceWith({
      data: {
        employeeId: "employee",
        type: "CHECK_IN_REJECTED",
        reason: "WEBAUTHN_FAILED",
      },
    });
    const header = timing.apply(new Response()).headers.get("Server-Timing")!;
    expect(header).toContain("verification;dur=");
    expect(header).toContain("tx_finish;dur=");
    expect(header).not.toContain("db_write;");
  });

  it("does not reach a transaction or retry when challenge consumption rejects", async () => {
    mocks.consumeChallenge.mockRejectedValue(
      new DomainError("CHALLENGE_REUSED", "Already used."),
    );
    const timing = new ServerTiming();
    await expect(
      recordAttendance(actor, "CHECK_IN", evidence, new Headers(), timing),
    ).rejects.toMatchObject({ code: "CHALLENGE_REUSED" });
    expect(mocks.consumeChallenge).toHaveBeenCalledOnce();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.rejection).toHaveBeenCalledOnce();
    expect(timing.apply(new Response()).headers.get("Server-Timing")).toContain(
      "challenge;dur=",
    );
  });

  it("rejects a failed commit and measures the transaction finish before logging rejection", async () => {
    const failure = new Error("commit failed");
    mocks.transaction.mockImplementation(async (run) => {
      await run(tx);
      throw failure;
    });
    const timing = new ServerTiming();
    await expect(
      recordAttendance(actor, "CHECK_IN", evidence, new Headers(), timing),
    ).rejects.toBe(failure);
    expect(mocks.rejection).toHaveBeenCalledExactlyOnceWith({
      data: {
        employeeId: "employee",
        type: "CHECK_IN_REJECTED",
        reason: "INTERNAL_ERROR",
      },
    });
    expect(timing.apply(new Response()).headers.get("Server-Timing")).toContain(
      "tx_finish;dur=",
    );
  });
});
