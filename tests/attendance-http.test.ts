import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "../src/lib/errors";

const mocks = vi.hoisted(() => ({
  requireEmployee: vi.fn(),
  assertSameOrigin: vi.fn(),
  rateLimit: vi.fn(),
  createEvent: vi.fn(),
  recordAttendance: vi.fn(),
  saveLateReason: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireEmployee: mocks.requireEmployee }));
vi.mock("@/lib/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  rateLimit: mocks.rateLimit,
}));
vi.mock("@/lib/db", () => ({
  db: { attendanceEvent: { create: mocks.createEvent } },
}));
vi.mock("@/modules/attendance/service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/modules/attendance/service")>();
  return {
    ...original,
    recordAttendance: mocks.recordAttendance,
    saveLateReason: mocks.saveLateReason,
  };
});
import { POST as checkIn } from "../src/app/api/attendance/check-in/route";
import { POST as checkOut } from "../src/app/api/attendance/check-out/route";
import { POST as lateReason } from "../src/app/api/attendance/late-reason/route";

const actor = {
  id: "user",
  employee: { id: "employee" },
  sessionId: "session",
};
const request = (body = "{}") =>
  new Request("https://attendance.example/api/attendance/check-in", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://attendance.example",
    },
    body,
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireEmployee.mockResolvedValue(actor);
  mocks.createEvent.mockResolvedValue({});
  mocks.recordAttendance.mockResolvedValue({ id: "record" });
  mocks.saveLateReason.mockResolvedValue({
    id: "record",
    lateReason: "Traffic.",
  });
});

describe("late reason HTTP endpoint", () => {
  it("requires authentication before reading or saving a reason", async () => {
    mocks.requireEmployee.mockRejectedValue(
      new DomainError("UNAUTHENTICATED", "Sign in.", 401),
    );
    const response = await lateReason(
      request(JSON.stringify({ attendanceId: "record", reason: "Traffic." })),
    );
    expect(response.status).toBe(401);
    expect(mocks.saveLateReason).not.toHaveBeenCalled();
  });

  it("checks the origin before evaluating the session", async () => {
    mocks.assertSameOrigin.mockImplementation(() => {
      throw new DomainError("INVALID_ORIGIN", "Invalid origin.", 403);
    });
    const response = await lateReason(request());
    expect(response.status).toBe(403);
    expect(mocks.requireEmployee).not.toHaveBeenCalled();
    expect(mocks.saveLateReason).not.toHaveBeenCalled();
  });

  it.each([
    { attendanceId: "record" },
    { attendanceId: "record", reason: "  " },
    { attendanceId: "record", reason: "a".repeat(1001) },
    { attendanceId: "record", reason: "Traffic.", employeeId: "other" },
  ])(
    "rejects invalid input without exposing the submitted text in events",
    async (body) => {
      const response = await lateReason(request(JSON.stringify(body)));
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
      expect(mocks.saveLateReason).not.toHaveBeenCalled();
      expect(mocks.createEvent).toHaveBeenCalledExactlyOnceWith({
        data: {
          employeeId: "employee",
          type: "LATE_REASON_REJECTED",
          reason: "VALIDATION_ERROR",
        },
      });
    },
  );

  it("rate limits submissions independently of check-in", async () => {
    mocks.rateLimit.mockImplementation(async (key: string) => {
      if (key === "attendance-late-reason:user")
        throw new DomainError("RATE_LIMITED", "Wait.", 429);
    });
    const response = await lateReason(
      request(JSON.stringify({ attendanceId: "record", reason: "Traffic." })),
    );
    expect(response.status).toBe(429);
    expect(mocks.saveLateReason).not.toHaveBeenCalled();
  });

  it("submits the trimmed reason and returns the canonical attendance response", async () => {
    const response = await lateReason(
      request(
        JSON.stringify({ attendanceId: "record", reason: "  Traffic.  " }),
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { id: "record", lateReason: "Traffic." },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.saveLateReason).toHaveBeenCalledExactlyOnceWith(actor, {
      attendanceId: "record",
      reason: "Traffic.",
    });
    expect(mocks.rateLimit).toHaveBeenCalledExactlyOnceWith(
      "attendance-late-reason:user",
      15,
      60,
    );
    expect(mocks.createEvent).not.toHaveBeenCalled();
  });
});

describe("attendance HTTP rejection logging", () => {
  it("logs malformed JSON once with the resolved employee and no raw input", async () => {
    const response = await checkIn(request("private raw invalid body"));
    expect(response.status).toBe(400);
    expect(mocks.createEvent).toHaveBeenCalledExactlyOnceWith({
      data: {
        employeeId: "employee",
        type: "CHECK_IN_REJECTED",
        reason: "INVALID_JSON",
      },
    });
    expect(mocks.recordAttendance).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.createEvent.mock.calls)).not.toContain(
      "private raw invalid body",
    );
  });
  it("logs strict schema failures for frontend verification flags", async () => {
    const response = await checkOut(
      request(JSON.stringify({ biometricVerified: true, insideOffice: true })),
    );
    expect(response.status).toBe(400);
    expect(mocks.createEvent).toHaveBeenCalledExactlyOnceWith({
      data: {
        employeeId: "employee",
        type: "CHECK_OUT_REJECTED",
        reason: "VALIDATION_ERROR",
      },
    });
  });
  it("logs failed authorization with a null employee and a bounded anonymous bucket", async () => {
    mocks.requireEmployee.mockRejectedValue(
      new DomainError("UNAUTHENTICATED", "Sign in.", 401),
    );
    const response = await checkIn(request());
    expect(response.status).toBe(401);
    expect(mocks.createEvent).toHaveBeenCalledExactlyOnceWith({
      data: {
        employeeId: null,
        type: "CHECK_IN_REJECTED",
        reason: "UNAUTHENTICATED",
      },
    });
    expect(mocks.rateLimit).toHaveBeenCalledExactlyOnceWith(
      "attendance-rejection:anonymous",
      10,
      60,
    );
  });
  it("logs invalid origins without evaluating the session or body", async () => {
    mocks.assertSameOrigin.mockImplementation(() => {
      throw new DomainError("INVALID_ORIGIN", "Invalid origin.", 403);
    });
    const response = await checkOut(request());
    expect(response.status).toBe(403);
    expect(mocks.requireEmployee).not.toHaveBeenCalled();
    expect(mocks.createEvent).toHaveBeenCalledExactlyOnceWith({
      data: {
        employeeId: null,
        type: "CHECK_OUT_REJECTED",
        reason: "INVALID_ORIGIN",
      },
    });
  });
  it("logs attendance rate-limit rejection using a separate logging budget", async () => {
    mocks.rateLimit.mockImplementation(async (key: string) => {
      if (key === "attendance:user")
        throw new DomainError("RATE_LIMITED", "Wait.", 429);
    });
    const response = await checkIn(request());
    expect(response.status).toBe(429);
    expect(mocks.createEvent).toHaveBeenCalledExactlyOnceWith({
      data: {
        employeeId: "employee",
        type: "CHECK_IN_REJECTED",
        reason: "RATE_LIMITED",
      },
    });
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      "attendance-rejection:user",
      30,
      60,
    );
  });
  it("caps anonymous log growth while preserving the original denial", async () => {
    mocks.requireEmployee.mockRejectedValue(
      new DomainError("UNAUTHENTICATED", "Sign in.", 401),
    );
    mocks.rateLimit.mockRejectedValue(
      new DomainError("RATE_LIMITED", "Wait.", 429),
    );
    const response = await checkIn(request());
    expect(response.status).toBe(401);
    expect(mocks.createEvent).not.toHaveBeenCalled();
  });
  it("does not duplicate rejection events owned by the domain service", async () => {
    mocks.recordAttendance.mockRejectedValue(
      new DomainError("WRONG_NETWORK", "Wrong network."),
    );
    const response = await checkIn(request());
    expect(response.status).toBe(400);
    expect(mocks.recordAttendance).toHaveBeenCalledExactlyOnceWith(
      actor,
      "CHECK_IN",
      {},
      expect.any(Headers),
    );
    expect(mocks.createEvent).not.toHaveBeenCalled();
  });
  it("delegates successful requests and keeps their canonical response", async () => {
    const response = await checkOut(request());
    expect(await response.json()).toEqual({
      success: true,
      data: { id: "record" },
    });
    expect(mocks.createEvent).not.toHaveBeenCalled();
  });
});
