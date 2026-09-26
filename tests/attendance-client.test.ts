// @vitest-environment jsdom
import { Activity, act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider } from "react-redux";
import { configureStore, type Middleware } from "@reduxjs/toolkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmployeeDashboard } from "@/components/employee-workspace";
import { baseApi } from "@/store/api/base-api";
import { workspaceUiReducer } from "@/store/features/workspace-ui/slice";
import {
  recordAttendance,
  registerDevice,
} from "@/lib/client/attendance-ceremony";
import { api } from "@/lib/client/request";
import { attendanceApi } from "@/store/features/attendance/api";
import type { AttendanceRecord } from "@/store/features/attendance/contracts";
import { workspaceClosed } from "@/store/features/workspace-ui/slice";

vi.mock("@/lib/client/alerts", () => ({
  confirmAction: vi.fn(),
  enqueueNotification: vi.fn(() => () => {}),
  resetAlerts: vi.fn(),
}));
vi.mock("@simplewebauthn/browser", () => ({
  WebAuthnAbortService: { cancelCeremony: vi.fn() },
  startAuthentication: vi.fn(async () => ({
    id: "synthetic-assertion-secret",
    response: { clientDataJSON: "synthetic-client-data" },
  })),
}));
const NativeRequest = globalThis.Request;
let root: Root;
let container: HTMLDivElement;
let state: "initial" | "recorded";
let failSubmission: boolean;
let failReconciliation: boolean;
let emptyInitialDay: boolean;
const calls: string[] = [];
const actions: unknown[] = [];
const record: AttendanceRecord = {
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
let savedRecord: AttendanceRecord;
let initialRecord: AttendanceRecord | undefined;
let app: ReturnType<typeof testStore>;
function testStore() {
  const capture: Middleware = () => (next) => (action) => {
    if (typeof action !== "function") actions.push(action);
    return next(action);
  };
  return configureStore({
    reducer: {
      [baseApi.reducerPath]: baseApi.reducer,
      workspaceUi: workspaceUiReducer,
    },
    middleware: (defaults) => defaults().concat(capture, baseApi.middleware),
  });
}
function button(label: string) {
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === label,
  )!;
}

beforeEach(() => {
  state = "initial";
  savedRecord = { ...record };
  initialRecord = undefined;
  failSubmission = false;
  failReconciliation = false;
  emptyInitialDay = false;
  calls.length = 0;
  actions.length = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "Request",
    class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(
          typeof input === "string"
            ? new URL(input, "http://localhost")
            : input,
          init,
        );
      }
    },
  );
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: (done: PositionCallback) =>
        done({
          coords: {
            latitude: 23.87654321,
            longitude: 90.12345678,
            accuracy: 3,
          },
        } as GeolocationPosition),
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string) => {
      const path = new URL(
        typeof input === "string" ? input : input.url,
        "http://localhost",
      ).pathname;
      calls.push(path);
      if (path === "/api/webauthn/authenticate/options")
        return Response.json({
          success: true,
          data: {
            required: true,
            requireGeofence: true,
            challengeId: "synthetic-challenge-secret",
            options: { challenge: "synthetic-options-secret" },
          },
        });
      if (
        path === "/api/attendance/check-in" ||
        path === "/api/attendance/check-out"
      ) {
        state = "recorded";
        if (failSubmission) throw new TypeError("Network interrupted");
        return Response.json({ success: true, data: savedRecord });
      }
      if (state === "recorded" && failReconciliation)
        throw new TypeError("Network interrupted");
      return Response.json({
        success: true,
        data: {
          employee: {
            id: "employee-one",
            employeeCode: "ONE",
            user: { name: "Example" },
            office: {
              name: "Office",
              timezone: "Asia/Dhaka",
              policy: { requireGeofence: true, requireOfficeNetwork: false },
            },
          },
          shift: {
            id: "shift-one",
            name: "Day",
            startTime: "09:00",
            endTime: "18:00",
            timezone: "Asia/Dhaka",
          },
          today:
            state === "recorded"
              ? savedRecord
              : emptyInitialDay
                ? null
                : (initialRecord ?? {
                    ...record,
                    id: undefined,
                    checkInAt: null,
                    status: "NOT_CHECKED_IN",
                  }),
          recent: [],
          devices: [],
          network: { verified: true },
          serverTime: "2026-09-24T03:00:00.000Z",
        },
      });
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  app = testStore();
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
    app.dispatch(baseApi.util.resetApiState());
  });
  container.remove();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => {
    root.render(
      h(Activity, {
        mode: "visible",
        children: h(Provider, { store: app, children: h(EmployeeDashboard) }),
      }),
    );
  });
  await act(async () => {
    await vi.waitFor(() => expect(calls).toContain("/api/attendance/me"));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const requestPath = (input: Request | string) =>
  new URL(typeof input === "string" ? input : input.url, "http://localhost")
    .pathname;

describe("attendance browser/Redux boundary", () => {
  it("measures click-to-render confirmation without logging evidence or waiting for a dashboard GET", async () => {
    window.history.replaceState(null, "", "/?attendanceTiming=1");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    await mount();
    await act(async () => {
      button("Check in").click();
    });
    await act(async () => {
      await vi.waitFor(() => expect(log).toHaveBeenCalled());
    });
    const event = log.mock.calls.find(
      ([label]) => label === "[attendance-timing]",
    )?.[1];
    expect(event).toMatchObject({
      action: "CHECK_IN",
      outcome: "confirmed",
      wallMs: expect.any(Number),
      postToVisibleMs: expect.any(Number),
    });
    expect(event.wallMs).toBeGreaterThanOrEqual(event.postToVisibleMs);
    expect(button("Check out").disabled).toBe(false);
    expect(container.textContent).toContain("You’re checked in.");
    expect(calls.filter((path) => path === "/api/attendance/me")).toHaveLength(
      1,
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /synthetic-|23\.87654321|90\.12345678|employee-one|attendance-one/,
    );
    expect(log).toHaveBeenCalledOnce();
  });

  it("allows a fresh attempt after a retained route cancels verification and is revealed", async () => {
    let completeLocation: PositionCallback | undefined;
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (done: PositionCallback) => {
          completeLocation = done;
        },
      },
    });
    await mount();
    await act(async () => {
      button("Check in").click();
    });
    await act(async () => {
      await vi.waitFor(() => expect(completeLocation).toBeTypeOf("function"));
    });
    await act(async () => {
      root.render(
        h(Activity, {
          mode: "hidden",
          children: h(Provider, { store: app, children: h(EmployeeDashboard) }),
        }),
      );
    });
    await act(async () => {
      root.render(
        h(Activity, {
          mode: "visible",
          children: h(Provider, { store: app, children: h(EmployeeDashboard) }),
        }),
      );
    });
    await act(async () => {
      await vi.waitFor(() => expect(button("Check in").disabled).toBe(false));
    });
    // Completing the cancelled attempt's GPS callback must have no effect.
    await act(async () => {
      completeLocation?.({
        coords: { latitude: 0, longitude: 0, accuracy: 3 },
        timestamp: Date.now(),
      } as GeolocationPosition);
    });
    expect(
      calls.filter((path) => path === "/api/attendance/check-in"),
    ).toHaveLength(0);
    await act(async () => {
      button("Check in").click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await act(async () => {
      completeLocation?.({
        coords: { latitude: 0, longitude: 0, accuracy: 3 },
        timestamp: Date.now(),
      } as GeolocationPosition);
    });
    await act(async () => {
      await vi.waitFor(() => expect(button("Check out").disabled).toBe(false));
    });
    expect(
      calls.filter((path) => path === "/api/attendance/check-in"),
    ).toHaveLength(1);
  });

  it("opens the late-reason dialog directly from confirmed attendance without a refetch", async () => {
    savedRecord = { ...record, lateMinutes: 20, status: "LATE" };
    await mount();
    await act(async () => {
      button("Check in").click();
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain(
          "Your check-in has been recorded",
        ),
      );
    });
    expect(container.textContent).toContain("20 minutes late");
    expect(calls.filter((path) => path === "/api/attendance/me")).toHaveLength(
      1,
    );
    const day = attendanceApi.endpoints.employeeDay.select()(
      app.getState(),
    ).data!;
    expect(day.today).toEqual(savedRecord);
    expect(day.shift?.id).toBe("shift-one");
    expect(day.employee.office.name).toBe("Office");
    expect(day.network.verified).toBe(true);
    expect(day.recent).toContainEqual(savedRecord);
  });

  it.each([false, true])(
    "renders checkout totals immediately (overnight=%s)",
    async (overnight) => {
      initialRecord = {
        ...record,
        attendanceDate: overnight
          ? "2026-09-23T00:00:00.000Z"
          : record.attendanceDate,
      };
      savedRecord = {
        ...initialRecord,
        checkOutAt: "2026-09-24T12:00:00.000Z",
        workedMinutes: 540,
        overtimeMinutes: 60,
      };
      await mount();
      await act(async () => {
        button("Check out").click();
      });
      await act(async () => {
        await vi.waitFor(() =>
          expect(container.textContent).toContain("You’re checked out."),
        );
      });
      expect(button("Check in").disabled).toBe(true);
      expect(button("Check out").disabled).toBe(true);
      expect(
        attendanceApi.endpoints.employeeDay.select()(app.getState()).data
          ?.today,
      ).toEqual(savedRecord);
      expect(
        calls.filter((path) => path === "/api/attendance/me"),
      ).toHaveLength(1);
      expect(
        calls.filter((path) => path === "/api/attendance/check-out"),
      ).toHaveLength(1);
    },
  );

  it("keeps an uncertain checkout locked when a successful GET only returns an open check-in", async () => {
    initialRecord = { ...record };
    failSubmission = true;
    // Simulate a request that did not close the record, but whose response was lost.
    savedRecord = { ...record };
    await mount();
    await act(async () => {
      button("Check out").click();
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain(
          "does not yet confirm this action",
        ),
      );
    });
    expect(button("Check out").disabled).toBe(true);
    expect(button("Check in").disabled).toBe(true);
    savedRecord = {
      ...record,
      checkOutAt: "2026-09-24T12:00:00.000Z",
      workedMinutes: 540,
    };
    await act(async () => {
      button("Refresh").click();
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain(
          "checked out. Your attendance was confirmed",
        ),
      );
    });
    expect(
      calls.filter((path) => path === "/api/attendance/check-out"),
    ).toHaveLength(1);
  });

  it("keeps an uncertain check-in locked when a successful recovery GET does not show the intended arrival", async () => {
    failSubmission = true;
    savedRecord = { ...record, checkInAt: null, status: "NOT_CHECKED_IN" };
    await mount();
    await act(async () => {
      button("Check in").click();
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain(
          "does not yet confirm this action",
        ),
      );
    });
    expect(button("Check in").disabled).toBe(true);
    expect(button("Check out").disabled).toBe(true);
    expect(
      calls.filter((path) => path === "/api/attendance/check-in"),
    ).toHaveLength(1);
  });

  it("fences an older dashboard response arriving after the confirmed save", async () => {
    const nativeFetch = vi.mocked(fetch).getMockImplementation()!;
    const post = deferred<Response>();
    const staleRead = deferred<Response>();
    let delayRead = false;
    let postStarted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string) => {
        const path = requestPath(input);
        if (path === "/api/attendance/check-in") {
          calls.push(path);
          postStarted = true;
          return post.promise;
        }
        if (path === "/api/attendance/me" && delayRead) {
          calls.push(path);
          return staleRead.promise; // Deliberately ignores AbortSignal.
        }
        return nativeFetch(input);
      }),
    );
    await mount();
    const before = attendanceApi.endpoints.employeeDay.select()(
      app.getState(),
    ).data!;
    await act(async () => {
      button("Check in").click();
    });
    await act(async () => {
      await vi.waitFor(() => expect(postStarted).toBe(true));
    });
    delayRead = true;
    await act(async () => {
      app.dispatch(
        attendanceApi.endpoints.employeeDay.initiate(undefined, {
          forceRefetch: true,
        }),
      );
    });
    await act(async () => {
      post.resolve(Response.json({ success: true, data: record }));
    });
    await act(async () => {
      await vi.waitFor(() => expect(button("Check out").disabled).toBe(false));
    });
    await act(async () => {
      staleRead.resolve(Response.json({ success: true, data: before }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(
      attendanceApi.endpoints.employeeDay.select()(app.getState()).data?.today,
    ).toEqual(record);
    expect(button("Check out").disabled).toBe(false);
  });

  it("ignores an attendance response after the workspace session closes", async () => {
    const nativeFetch = vi.mocked(fetch).getMockImplementation()!;
    const post = deferred<Response>();
    let postStarted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string) => {
        if (requestPath(input) === "/api/attendance/check-in") {
          postStarted = true;
          return post.promise;
        }
        return nativeFetch(input);
      }),
    );
    await mount();
    await act(async () => {
      button("Check in").click();
    });
    await act(async () => {
      await vi.waitFor(() => expect(postStarted).toBe(true));
    });
    await act(async () => {
      app.dispatch(workspaceClosed("signed-out"));
    });
    await act(async () => {
      post.resolve(Response.json({ success: true, data: record }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(container.textContent).not.toContain("You’re checked in.");
    expect(
      actions.filter((action) => baseApi.util.invalidateTags.match(action)),
    ).toHaveLength(0);
  });

  it.each(["unmount", "hide"] as const)(
    "does not send attendance after route %s while location is pending",
    async (mode) => {
      let completeLocation: PositionCallback | undefined;
      Object.defineProperty(navigator, "geolocation", {
        configurable: true,
        value: {
          getCurrentPosition: (done: PositionCallback) => {
            completeLocation = done;
          },
        },
      });
      await mount();
      await act(async () => {
        button("Check in").click();
      });
      await act(async () => {
        await vi.waitFor(() => expect(completeLocation).toBeTypeOf("function"));
      });
      await act(async () => {
        root.render(
          mode === "unmount"
            ? null
            : h(Activity, {
                mode: "hidden",
                children: h(Provider, {
                  store: app,
                  children: h(EmployeeDashboard),
                }),
              }),
        );
      });
      await act(async () => {
        completeLocation?.({
          coords: {
            latitude: 23.87654321,
            longitude: 90.12345678,
            accuracy: 3,
          },
        } as GeolocationPosition);
      });
      expect(calls).not.toContain("/api/attendance/check-in");
      expect(
        actions.filter((action) => baseApi.util.invalidateTags.match(action)),
      ).toHaveLength(0);
    },
  );

  it("does not continue an optional-passkey ceremony after its challenge response is aborted", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      controller.abort();
      return Response.json({
        success: true,
        data: { required: false, requireGeofence: false },
      });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(
      recordAttendance({
        action: "CHECK_IN",
        progress: vi.fn(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not continue registration after the challenge is aborted", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      controller.abort();
      return Response.json({
        success: true,
        data: { challengeId: "synthetic-challenge-secret", options: {} },
      });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(
      registerDevice("Example", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves an intentional fetch abort instead of reporting an ambiguous network write", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("Cancelled", "AbortError");
      }),
    );
    await expect(api("/api/webauthn/register/options")).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("renders the confirmed response without another dashboard GET, keeps evidence out of Redux and blocks duplicate submissions", async () => {
    await mount();
    await act(async () => {
      button("Check in").click();
      button("Check in").click();
    });
    await act(async () => {
      await vi.waitFor(() => expect(button("Check out").disabled).toBe(false));
    });
    expect(calls.filter((path) => path === "/api/attendance/me")).toHaveLength(
      1,
    );
    expect(container.textContent).toContain("You’re checked in.");
    expect(
      calls.filter((path) => path === "/api/attendance/check-in"),
    ).toHaveLength(1);
    const redux = JSON.stringify({ state: app.getState(), actions });
    for (const secret of [
      "synthetic-challenge-secret",
      "synthetic-options-secret",
      "synthetic-assertion-secret",
      "synthetic-client-data",
      "23.87654321",
      "90.12345678",
    ])
      expect(redux).not.toContain(secret);
  });

  it("keeps confirmed attendance visible and checkout usable when a later refresh fails and the initial day was empty", async () => {
    emptyInitialDay = true;
    failReconciliation = true;
    await mount();
    await act(async () => {
      button("Check in").click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(button("Check in").disabled).toBe(true);
    expect(button("Check out").disabled).toBe(false);
    expect(calls.filter((path) => path === "/api/attendance/me")).toHaveLength(
      1,
    );
    await act(async () => {
      button("Refresh").click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(container.textContent).toContain("You’re checked in.");
    expect(container.textContent).toContain("Refresh failed");
    expect(button("Check out").disabled).toBe(false);
    expect(
      calls.filter((path) => path === "/api/attendance/check-in"),
    ).toHaveLength(1);
  });

  it("reconciles an ambiguous completed write without replaying a challenge or request", async () => {
    failSubmission = true;
    await mount();
    await act(async () => {
      button("Check in").click();
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          calls.filter((path) => path === "/api/attendance/me"),
        ).toHaveLength(2),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(button("Check in").disabled).toBe(true);
    expect(button("Check out").disabled).toBe(false);
    expect(
      calls.filter((path) => path === "/api/attendance/check-in"),
    ).toHaveLength(1);
    expect(
      calls.filter((path) => path === "/api/webauthn/authenticate/options"),
    ).toHaveLength(1);
  });

  it("keeps attendance disabled while reconciliation fails and lets manual refresh recover", async () => {
    failSubmission = true;
    failReconciliation = true;
    await mount();
    await act(async () => {
      button("Check in").click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(button("Check in").disabled).toBe(true);
    expect(button("Check out").disabled).toBe(true);
    failReconciliation = false;
    await act(async () => {
      button("Refresh").click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(button("Check out").disabled).toBe(false);
    expect(
      calls.filter((path) => path === "/api/attendance/check-in"),
    ).toHaveLength(1);
  });
});
