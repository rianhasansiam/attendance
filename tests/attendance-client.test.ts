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
            challengeId: "synthetic-challenge-secret",
            options: { challenge: "synthetic-options-secret" },
          },
        });
      if (path === "/api/attendance/check-in") {
        state = "recorded";
        if (failSubmission) throw new TypeError("Network interrupted");
        return Response.json({ success: true, data: record });
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
              ? record
              : emptyInitialDay
                ? null
                : {
                    ...record,
                    id: undefined,
                    checkInAt: null,
                    status: "NOT_CHECKED_IN",
                  },
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

describe("attendance browser/Redux boundary", () => {
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
      return Response.json({ success: true, data: { required: false } });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(
      recordAttendance({
        action: "CHECK_IN",
        requireGeofence: false,
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

  it("keeps WebAuthn and precise location out of Redux, confirms then invalidates once, and blocks duplicate submissions", async () => {
    await mount();
    await act(async () => {
      button("Check in").click();
      button("Check in").click();
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          calls.filter((path) => path === "/api/attendance/me"),
        ).toHaveLength(2),
      );
    });
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

  it("keeps a confirmed check-in disabled when its first refresh fails and previous day data was empty", async () => {
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
