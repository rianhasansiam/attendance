import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type {
  AttendanceRecord,
  CheckoutPreview,
  EmployeeDay,
} from "../src/store/features/attendance/contracts";
import {
  attendanceIntent,
  recoveredAttendance,
} from "../src/lib/client/attendance-recovery";

const before: AttendanceRecord = {
  id: "attendance-1",
  attendanceDate: "2026-11-12T00:00:00.000Z",
  checkInAt: "2026-11-12T14:00:00.000Z",
  checkOutAt: null,
  status: "PRESENT",
  lateMinutes: 0,
  lateReason: null,
  workedMinutes: 0,
  overtimeMinutes: 0,
  approvedOvertimeMinutes: 0,
  requestedOvertimeMinutes: null,
  overtimeRequestStatus: null,
  overtimeApprovalMatchesAttendance: false,
};
const checkedOut: AttendanceRecord = {
  ...before,
  checkOutAt: "2026-11-13T00:15:00.000Z",
  workedMinutes: 615,
  overtimeMinutes: 75,
  approvedOvertimeMinutes: 0,
  requestedOvertimeMinutes: 75,
  overtimeRequestStatus: "PENDING",
  overtimeRequestId: "request-1",
};
const preview: CheckoutPreview = {
  attendanceId: before.id!,
  employeeName: "Night shift employee",
  scheduledEndAt: "2026-11-12T23:00:00.000Z",
  serverTime: "2026-11-13T00:15:00.000Z",
  extraMinutes: 75,
  eligible: true,
  timezone: "UTC",
};

function day(today: AttendanceRecord): EmployeeDay {
  return {
    employee: {
      id: "employee-1",
      employeeCode: "EMP-1",
      user: {
        name: "Night shift employee",
        email: "night@example.test",
        image: null,
      },
      department: null,
      office: {
        id: "office-1",
        name: "Night office",
        address: "Test office",
        timezone: "UTC",
        policy: { requireGeofence: true, requireOfficeNetwork: false },
      },
    },
    shift: {
      id: "shift-1",
      name: "Night",
      startTime: "14:00",
      endTime: "23:00",
      timezone: "UTC",
    },
    today,
    recent: [today],
    devices: [],
    network: { verified: null },
    serverTime: "2026-11-13T00:14:00.000Z",
  };
}

test("checkout ceremony uses fresh evidence and keeps overtime details in the final write", async (t) => {
  let proofCount = 0;
  let locationCount = 0;
  const browser = mock.module("@simplewebauthn/browser", {
    namedExports: {
      startAuthentication: async ({
        optionsJSON,
      }: {
        optionsJSON: { challenge: string };
      }) => ({
        id: `proof-${++proofCount}`,
        challenge: optionsJSON.challenge,
      }),
      WebAuthnAbortService: { cancelCeremony() {} },
    },
  });
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      permissions: { query: async () => ({ state: "granted" }) },
      geolocation: {
        getCurrentPosition(
          success: (position: {
            coords: { latitude: number; longitude: number; accuracy: number };
            timestamp: number;
          }) => void,
        ) {
          success({
            coords: { latitude: ++locationCount, longitude: 90, accuracy: 5 },
            timestamp: Date.now(),
          });
        },
      },
    },
  });
  t.after(() => {
    browser.restore();
    if (navigatorDescriptor)
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, "navigator");
  });
  const { recordAttendance, readCheckoutPreview, UncertainCeremonyError } =
    await import("../src/lib/client/attendance-ceremony");
  type Call = { url: string; method: string; body?: Record<string, unknown> };
  const reason =
    "Completed inventory reconciliation after the scheduled shift.";

  await t.test(
    "preview is a read; checkout ID and reason never enter challenge options",
    async (t) => {
      const calls: Call[] = [];
      t.mock.method(
        globalThis,
        "fetch",
        async (input: string | URL | Request, init?: RequestInit) => {
          const call = {
            url: String(input),
            method: init?.method ?? "GET",
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
          };
          calls.push(call);
          const data =
            call.method === "GET"
              ? preview
              : call.url.endsWith("/options")
                ? {
                    required: true,
                    requireGeofence: true,
                    challengeId: "challenge-1",
                    options: { challenge: "nonce-1" },
                  }
                : checkedOut;
          return Response.json({ success: true, data });
        },
      );
      assert.deepEqual(await readCheckoutPreview(), preview);
      assert.equal(proofCount, 0);
      assert.equal(locationCount, 0);
      const result = await recordAttendance({
        action: "CHECK_OUT",
        checkout: { attendanceId: before.id!, overtimeReason: reason },
        progress() {},
      });
      assert.equal(result.overtimeRequestStatus, "PENDING");
      assert.equal(result.approvedOvertimeMinutes, 0);
      assert.deepEqual(calls[0], {
        url: "/api/attendance/check-out",
        method: "GET",
      });
      assert.deepEqual(calls[1].body, { action: "CHECK_OUT" });
      assert.deepEqual(calls[2].body, {
        attendanceId: before.id,
        overtimeReason: reason,
        challengeId: "challenge-1",
        response: { id: "proof-1", challenge: "nonce-1" },
        location: { latitude: 1, longitude: 90, accuracy: 5 },
      });
    },
  );

  await t.test(
    "threshold crossing stops the write; resubmission collects a new challenge, passkey and GPS",
    async (t) => {
      proofCount = 0;
      locationCount = 0;
      const calls: Call[] = [];
      let optionsCount = 0;
      t.mock.method(
        globalThis,
        "fetch",
        async (input: string | URL | Request, init?: RequestInit) => {
          const call = {
            url: String(input),
            method: init?.method ?? "GET",
            body: JSON.parse(String(init?.body ?? "{}")),
          };
          calls.push(call);
          if (call.url.endsWith("/options")) {
            optionsCount++;
            return Response.json({
              success: true,
              data: {
                required: true,
                requireGeofence: true,
                challengeId: `challenge-${optionsCount}`,
                options: { challenge: `nonce-${optionsCount}` },
              },
            });
          }
          if (!call.body.overtimeReason)
            return Response.json(
              {
                success: false,
                error: {
                  code: "OVERTIME_REASON_REQUIRED",
                  message: "Provide an overtime reason.",
                },
              },
              { status: 409 },
            );
          return Response.json({ success: true, data: checkedOut });
        },
      );
      await assert.rejects(
        recordAttendance({
          action: "CHECK_OUT",
          checkout: { attendanceId: before.id! },
          progress() {},
        }),
        { code: "OVERTIME_REASON_REQUIRED" },
      );
      assert.equal(
        calls.length,
        2,
        "The rejected ceremony must not retry its proof or POST.",
      );
      await recordAttendance({
        action: "CHECK_OUT",
        checkout: { attendanceId: before.id!, overtimeReason: reason },
        progress() {},
      });
      assert.equal(calls.length, 4);
      assert.equal(optionsCount, 2);
      assert.equal(proofCount, 2);
      assert.equal(locationCount, 2);
      assert.equal(calls[3].body?.challengeId, "challenge-2");
      assert.deepEqual(calls[3].body?.response, {
        id: "proof-2",
        challenge: "nonce-2",
      });
      assert.deepEqual(calls[3].body?.location, {
        latitude: 2,
        longitude: 90,
        accuracy: 5,
      });
    },
  );

  await t.test(
    "lost checkout response is uncertain and never automatically replays the write",
    async (t) => {
      let calls = 0;
      t.mock.method(
        globalThis,
        "fetch",
        async (input: string | URL | Request) => {
          calls++;
          if (String(input).endsWith("/options"))
            return Response.json({
              success: true,
              data: { required: false, requireGeofence: false },
            });
          throw new TypeError("Connection interrupted after request delivery");
        },
      );
      await assert.rejects(
        recordAttendance({
          action: "CHECK_OUT",
          checkout: { attendanceId: before.id!, overtimeReason: reason },
          progress() {},
        }),
        UncertainCeremonyError,
      );
      assert.equal(calls, 2);
    },
  );

  await t.test("check-in does not submit checkout-only fields", async (t) => {
    const bodies: Record<string, unknown>[] = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({
          success: true,
          data: String(input).endsWith("/options")
            ? { required: false, requireGeofence: false }
            : before,
        });
      },
    );
    await recordAttendance({
      action: "CHECK_IN",
      checkout: { attendanceId: before.id!, overtimeReason: reason },
      progress() {},
    });
    assert.deepEqual(bodies, [{ action: "CHECK_IN" }, {}]);
  });
});

test("uncertain overnight checkout recovery retains pending status and zero approved credit", () => {
  const intent = attendanceIntent("CHECK_OUT", day(before));
  const recovered = recoveredAttendance(
    { ...day(checkedOut), recent: [checkedOut] },
    intent,
  );
  assert.equal(recovered?.id, before.id);
  assert.equal(recovered?.overtimeRequestStatus, "PENDING");
  assert.equal(recovered?.requestedOvertimeMinutes, 75);
  assert.equal(recovered?.approvedOvertimeMinutes, 0);
  assert.equal(recoveredAttendance(day(before), intent), undefined);
  assert.equal(
    recoveredAttendance(
      day({ ...checkedOut, id: "another-attendance" }),
      intent,
    ),
    undefined,
  );
  assert.equal(
    recoveredAttendance(
      day({ ...checkedOut, checkOutAt: "2026-11-12T22:00:00.000Z" }),
      intent,
    ),
    undefined,
  );
});
