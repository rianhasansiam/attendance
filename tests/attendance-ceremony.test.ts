// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordAttendance,
  UncertainCeremonyError,
} from "@/lib/client/attendance-ceremony";
import { beginAttendanceTiming } from "@/lib/client/attendance-timing";

const webauthn = vi.hoisted(() => ({
  authenticate: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: webauthn.authenticate,
  WebAuthnAbortService: { cancelCeremony: webauthn.cancel },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const assertion = { id: "private-credential", response: "private-assertion" };
const record = {
  id: "attendance-one",
  attendanceDate: "2026-09-24T00:00:00.000Z",
  checkInAt: "2026-09-24T03:00:00.000Z",
  checkOutAt: null,
  status: "PRESENT",
  lateMinutes: 0,
  lateReason: null,
  workedMinutes: 0,
  overtimeMinutes: 0,
};
const location = { latitude: 23.87654321, longitude: 90.12345678, accuracy: 3 };
let options: Record<string, unknown>;
let requests: {
  path: string;
  body: Record<string, unknown>;
  init?: RequestInit;
}[];
let positions: { done: PositionCallback; fail: PositionErrorCallback | null }[];
let gps: ReturnType<typeof vi.fn>;
let permission: ReturnType<typeof vi.fn>;
let fetch: ReturnType<typeof vi.fn>;
let now: number;
const postRequests = () =>
  requests.filter(({ path }) => path.startsWith("/api/attendance/"));
const attempt = (
  action: "CHECK_IN" | "CHECK_OUT" = "CHECK_IN",
  signal?: AbortSignal,
) => recordAttendance({ action, signal, progress: vi.fn() });
function fix(index = 0, timestamp = Date.now(), accuracy = 3) {
  positions[index].done({
    coords: { ...location, accuracy },
    timestamp,
  } as GeolocationPosition);
}

beforeEach(() => {
  vi.clearAllMocks();
  options = {
    required: true,
    requireGeofence: true,
    challengeId: "private-challenge-id",
    options: { challenge: "private-challenge" },
  };
  requests = [];
  positions = [];
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  permission = vi.fn(async () => ({ state: "granted" }));
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: { query: permission },
  });
  gps = vi.fn((done: PositionCallback, fail: PositionErrorCallback | null) => {
    positions.push({ done, fail });
  });
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: { getCurrentPosition: gps },
  });
  webauthn.authenticate.mockResolvedValue(assertion);
  fetch = vi.fn(async (path: string, init?: RequestInit) => {
    requests.push({ path, body: JSON.parse(String(init?.body || "{}")), init });
    return Response.json({
      success: true,
      data: path.includes("authenticate/options") ? options : record,
    });
  });
  vi.stubGlobal("fetch", fetch);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("attendance verification requirements", () => {
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])(
    "uses current options for passkey=%s GPS=%s on checkout",
    async (required, requireGeofence) => {
      options = { ...options, required, requireGeofence };
      const result = attempt("CHECK_OUT");
      if (requireGeofence) {
        await vi.waitFor(() => expect(gps).toHaveBeenCalledOnce());
        fix();
      }
      await expect(result).resolves.toEqual(record);
      expect(webauthn.authenticate).toHaveBeenCalledTimes(required ? 1 : 0);
      expect(gps).toHaveBeenCalledTimes(requireGeofence ? 1 : 0);
      expect(permission).toHaveBeenCalledTimes(
        required && requireGeofence ? 1 : 0,
      );
      expect(postRequests()).toHaveLength(1);
      expect(postRequests()[0].path).toBe("/api/attendance/check-out");
      expect(postRequests()[0].body.response).toEqual(
        required ? assertion : undefined,
      );
      expect(postRequests()[0].body.location).toEqual(
        requireGeofence ? location : undefined,
      );
      if (requireGeofence)
        expect(gps.mock.calls[0][2]).toEqual({
          enableHighAccuracy: true,
          timeout: 20000,
          maximumAge: 0,
        });
    },
  );

  it.each([
    { required: false },
    { requireGeofence: false },
    { required: true, requireGeofence: false },
    { required: "false", requireGeofence: false },
  ])(
    "fails closed for malformed current requirements %j",
    async (malformed) => {
      options = malformed;
      await expect(attempt()).rejects.toThrow(
        "Verification requirements are unavailable",
      );
      expect(postRequests()).toHaveLength(0);
      expect(gps).not.toHaveBeenCalled();
      expect(webauthn.authenticate).not.toHaveBeenCalled();
    },
  );
});

describe("parallel verification and safe permission prompts", () => {
  it.each(["passkey", "gps"] as const)(
    "waits for both branches when %s completes first",
    async (first) => {
      const device = deferred<typeof assertion>();
      webauthn.authenticate.mockReturnValue(device.promise);
      const result = attempt();
      await vi.waitFor(() => {
        expect(gps).toHaveBeenCalledOnce();
        expect(webauthn.authenticate).toHaveBeenCalledOnce();
      });
      if (first === "gps") fix();
      else device.resolve(assertion);
      await Promise.resolve();
      expect(postRequests()).toHaveLength(0);
      if (first === "gps") device.resolve(assertion);
      else fix();
      await expect(result).resolves.toEqual(record);
      expect(postRequests()).toHaveLength(1);
    },
  );

  it.each(["prompt", "denied", "unsupported", "failure", "sync-failure"])(
    "keeps first location prompt sequential for %s permission",
    async (state) => {
      const device = deferred<typeof assertion>();
      webauthn.authenticate.mockReturnValue(device.promise);
      if (state === "unsupported")
        Object.defineProperty(navigator, "permissions", {
          configurable: true,
          value: undefined,
        });
      else if (state === "failure")
        permission.mockRejectedValue(new Error("Unavailable"));
      else if (state === "sync-failure")
        permission.mockImplementation(() => {
          throw new Error("Unavailable");
        });
      else permission.mockResolvedValue({ state });
      const result = attempt();
      await vi.waitFor(() =>
        expect(webauthn.authenticate).toHaveBeenCalledOnce(),
      );
      expect(gps).not.toHaveBeenCalled();
      device.resolve(assertion);
      await vi.waitFor(() => expect(gps).toHaveBeenCalledOnce());
      fix();
      await expect(result).resolves.toEqual(record);
    },
  );

  it("falls back if optional permissions inspection does not resolve", async () => {
    permission.mockReturnValue(new Promise(() => {}));
    const result = attempt();
    await vi.waitFor(() => expect(gps).toHaveBeenCalledOnce());
    fix();
    await expect(result).resolves.toEqual(record);
  });

  it.each([1, 2, 3])(
    "GPS failure %s aborts a pending passkey without submitting",
    async (code) => {
      const device = deferred<typeof assertion>();
      webauthn.authenticate.mockReturnValue(device.promise);
      const result = attempt();
      const failure = expect(result).rejects.toThrow(
        code === 1
          ? "Location permission is required"
          : "Your location could not be determined",
      );
      await vi.waitFor(() =>
        expect(webauthn.authenticate).toHaveBeenCalledOnce(),
      );
      positions[0].fail?.({ code } as GeolocationPositionError);
      await failure;
      expect(webauthn.cancel).toHaveBeenCalledOnce();
      device.reject(new Error("late device failure"));
      await Promise.resolve();
      expect(postRequests()).toHaveLength(0);
    },
  );

  it("passkey cancellation rejects promptly and ignores a late GPS result", async () => {
    const device = deferred<typeof assertion>();
    webauthn.authenticate.mockReturnValue(device.promise);
    const result = attempt();
    const failure = expect(result).rejects.toMatchObject({
      name: "NotAllowedError",
    });
    await vi.waitFor(() => expect(gps).toHaveBeenCalledOnce());
    device.reject(new DOMException("Cancelled", "NotAllowedError"));
    await failure;
    fix();
    await Promise.resolve();
    expect(postRequests()).toHaveLength(0);
  });

  it("abort cancels the pending device and ignores both later results", async () => {
    const controller = new AbortController();
    const device = deferred<typeof assertion>();
    webauthn.authenticate.mockReturnValue(device.promise);
    const result = attempt("CHECK_IN", controller.signal);
    const failure = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() =>
      expect(webauthn.authenticate).toHaveBeenCalledOnce(),
    );
    controller.abort();
    await failure;
    expect(webauthn.cancel).toHaveBeenCalledOnce();
    fix();
    device.resolve(assertion);
    await Promise.resolve();
    expect(postRequests()).toHaveLength(0);
  });

  it("abort stops pending permission inspection before either prompt", async () => {
    permission.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const result = attempt("CHECK_IN", controller.signal);
    const failure = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(permission).toHaveBeenCalledOnce());
    controller.abort();
    await failure;
    expect(gps).not.toHaveBeenCalled();
    expect(webauthn.authenticate).not.toHaveBeenCalled();
  });
});

describe("location freshness and one-shot submission", () => {
  it("reacquires GPS after a long passkey interaction", async () => {
    const device = deferred<typeof assertion>();
    webauthn.authenticate.mockReturnValue(device.promise);
    const result = attempt();
    await vi.waitFor(() => expect(gps).toHaveBeenCalledOnce());
    fix();
    now = 30_001;
    device.resolve(assertion);
    await vi.waitFor(() => expect(gps).toHaveBeenCalledTimes(2));
    expect(postRequests()).toHaveLength(0);
    positions[1].done({
      coords: { ...location, latitude: 23.5 },
      timestamp: Date.now(),
    } as GeolocationPosition);
    await expect(result).resolves.toEqual(record);
    expect(postRequests()[0].body.location).toEqual({
      ...location,
      latitude: 23.5,
    });
  });

  it("rejects repeatedly stale browser fixes without submitting", async () => {
    options.required = false;
    const result = attempt();
    const failure = expect(result).rejects.toThrow(
      "A fresh location could not be obtained",
    );
    await vi.waitFor(() => expect(gps).toHaveBeenCalledOnce());
    fix(0, Date.now() - 31_000);
    await vi.waitFor(() => expect(gps).toHaveBeenCalledTimes(2));
    fix(1, Date.now() - 31_000);
    await failure;
    expect(postRequests()).toHaveLength(0);
  });

  it("preserves reported GPS accuracy for authoritative server rejection", async () => {
    options.required = false;
    fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      requests.push({
        path,
        body: JSON.parse(String(init?.body || "{}")),
        init,
      });
      return path.includes("authenticate/options")
        ? Response.json({ success: true, data: options })
        : Response.json(
            {
              success: false,
              error: {
                code: "LOCATION_INACCURATE",
                message: "Location is not accurate enough.",
              },
            },
            { status: 400 },
          );
    });
    const result = attempt();
    const failure = expect(result).rejects.toMatchObject({
      code: "LOCATION_INACCURATE",
    });
    await vi.waitFor(() => expect(gps).toHaveBeenCalledOnce());
    fix(0, Date.now(), 1000);
    await failure;
    expect(postRequests()[0].body.location).toEqual({
      ...location,
      accuracy: 1000,
    });
    expect(postRequests()).toHaveLength(1);
  });

  it.each(["CHALLENGE_EXPIRED", "CHALLENGE_CONSUMED"])(
    "does not retry a server-rejected %s",
    async (code) => {
      options.requireGeofence = false;
      fetch.mockImplementation(async (path: string, init?: RequestInit) => {
        requests.push({
          path,
          body: JSON.parse(String(init?.body || "{}")),
          init,
        });
        return path.includes("authenticate/options")
          ? Response.json({ success: true, data: options })
          : Response.json(
              {
                success: false,
                error: { code, message: "Verification expired." },
              },
              { status: 409 },
            );
      });
      await expect(attempt()).rejects.toMatchObject({ code });
      expect(postRequests()).toHaveLength(1);
      expect(webauthn.authenticate).toHaveBeenCalledOnce();
    },
  );

  it("reports a lost POST response as uncertain without automatically replaying", async () => {
    options = { required: false, requireGeofence: false };
    fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      requests.push({
        path,
        body: JSON.parse(String(init?.body || "{}")),
        init,
      });
      if (path.includes("authenticate/options"))
        return Response.json({ success: true, data: options });
      throw new TypeError("Network interrupted");
    });
    await expect(attempt()).rejects.toBeInstanceOf(UncertainCeremonyError);
    expect(postRequests()).toHaveLength(1);
  });

  it("sends opt-in timing headers without logging verification evidence", async () => {
    window.history.replaceState(null, "", "/?attendanceTiming=1");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const timing = beginAttendanceTiming("CHECK_IN");
    const result = recordAttendance({
      action: "CHECK_IN",
      progress: vi.fn(),
      timing,
    });
    await vi.waitFor(() => expect(gps).toHaveBeenCalledOnce());
    fix();
    await result;
    timing.finish("confirmed");
    expect(
      requests.every(
        ({ init }) =>
          init?.headers &&
          (init.headers as Record<string, string>)["x-attendance-timing"] ===
            "1",
      ),
    ).toBe(true);
    const logged = JSON.stringify(log.mock.calls);
    for (const secret of [
      "private-credential",
      "private-assertion",
      "private-challenge",
      "23.87654321",
      "90.12345678",
      "attendance-one",
    ])
      expect(logged).not.toContain(secret);
    expect(log).toHaveBeenCalledOnce();
  });
});
