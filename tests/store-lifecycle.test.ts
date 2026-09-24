// @vitest-environment jsdom
import { Activity, act, createElement as h, type ReactNode } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { Provider } from "react-redux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreProvider } from "@/store/provider";
import { useAppStore } from "@/store/hooks";
import {
  makeStore,
  clearWorkspaceData,
  type AppStore,
} from "@/store/make-store";
import {
  listenToBrowser,
  useFreshness,
  attendancePollMs,
} from "@/store/freshness";
import { managementApi } from "@/store/features/management/api";

const auth = vi.hoisted(() => ({
  session: {
    user: { id: "a", role: "ADMIN" as const },
    sessionId: "session-a",
  },
}));
vi.mock("next-auth/react", () => ({
  SessionProvider: ({ children }: { children: ReactNode }) => children,
  useSession: () => ({ status: "authenticated", data: auth.session }),
  getSession: vi.fn(),
}));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const NativeRequest = globalThis.Request;
let root: Root | undefined;
let container: HTMLDivElement;
const stores: AppStore[] = [];
let visible = true;
let online = true;
beforeEach(() => {
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
  visible = true;
  online = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
    visible ? "visible" : "hidden",
  );
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  auth.session = {
    user: { id: "a", role: "ADMIN" as const },
    sessionId: "session-a",
  };
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  stores.splice(0).forEach(clearWorkspaceData);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("workspace provider lifetime", () => {
  it("hydrates identically, preserves its store across route children, and replaces it for an identity change", async () => {
    const observed: AppStore[] = [];
    function Probe({ route }: { route: string }) {
      const store = useAppStore();
      observed.push(store);
      return h("span", null, route);
    }
    const tree = (route: string) =>
      h(StoreProvider, {
        identity: { ...auth.session.user, sessionId: auth.session.sessionId },
        children: h(Probe, { route }),
      });
    container.innerHTML = renderToString(tree("dashboard"));
    const errors: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(container, tree("dashboard"), {
        onRecoverableError: (error) => errors.push(error),
      });
    });
    const first = observed.at(-1)!;
    await act(async () => root!.render(tree("history")));
    expect(observed.at(-1)).toBe(first);
    expect(container.textContent).toBe("history");
    expect(errors).toEqual([]);
    auth.session = {
      user: { id: "b", role: "ADMIN" as const },
      sessionId: "session-b",
    };
    await act(async () => root!.render(tree("dashboard")));
    expect(observed.at(-1)).not.toBe(first);
    expect(Object.keys(first.getState().workspaceApi.queries)).toHaveLength(0);
  });

  it("cleans up browser focus/reconnect listeners for each provider lifetime", () => {
    const store = makeStore();
    stores.push(store);
    const stop = listenToBrowser(store.dispatch);
    online = false;
    window.dispatchEvent(new Event("offline"));
    expect(store.getState().workspaceApi.config.online).toBe(false);
    expect(store.getState().workspaceApi.config.focused).toBe(false);
    stop();
    online = true;
    window.dispatchEvent(new Event("online"));
    expect(store.getState().workspaceApi.config.online).toBe(false);
    const stopAgain = listenToBrowser(store.dispatch);
    window.dispatchEvent(new Event("online"));
    expect(store.getState().workspaceApi.config.online).toBe(true);
    stopAgain();
  });

  it("polls only active visible online views, stops under Activity, and refreshes on reveal", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () =>
      Response.json({
        success: true,
        data: { items: [], total: 0, page: 1, pageSize: 25 },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const store = makeStore();
    stores.push(store);
    function LiveView() {
      const result = managementApi.useGetManagementQuery(
        { resource: "departments", params: { page: 1, pageSize: 25 } },
        useFreshness(true),
      );
      return h("span", null, result.isFetching ? "refreshing" : "ready");
    }
    const tree = (mode: "visible" | "hidden") =>
      h(Provider, {
        store,
        children: h(Activity, { mode, children: h(LiveView) }),
      });
    root = createRoot(container);
    await act(async () => {
      root!.render(tree("visible"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    const initial = fetch.mock.calls.length;
    expect(initial).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(attendancePollMs + 10);
    });
    expect(fetch).toHaveBeenCalledTimes(initial + 1);
    await act(async () => {
      visible = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const hidden = fetch.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(attendancePollMs * 2);
    });
    expect(fetch).toHaveBeenCalledTimes(hidden);
    await act(async () => {
      visible = true;
      online = false;
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("offline"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(attendancePollMs * 2);
    });
    expect(fetch).toHaveBeenCalledTimes(hidden);
    await act(async () => root!.render(tree("hidden")));
    await act(async () => {
      online = true;
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(attendancePollMs * 2);
    });
    expect(fetch).toHaveBeenCalledTimes(hidden);
    await act(async () => root!.render(tree("visible")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(fetch).toHaveBeenCalledTimes(hidden + 1);
    await act(async () => root!.unmount());
    root = undefined;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(attendancePollMs * 2);
    });
    expect(fetch).toHaveBeenCalledTimes(hidden + 1);
  });
});
