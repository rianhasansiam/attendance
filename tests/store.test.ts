import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeStore,
  clearWorkspaceData,
  type AppStore,
} from "@/store/make-store";
import { managementApi } from "@/store/features/management/api";
import { workspaceClosed } from "@/store/features/workspace-ui/slice";
import { normalizeError } from "@/store/api/errors";
import { useQueryView } from "@/store/use-query-view";

const NativeRequest = globalThis.Request;
const stores: AppStore[] = [];
const store = () => {
  const value = makeStore();
  stores.push(value);
  return value;
};
const response = (data: unknown, status = 200) =>
  Response.json(
    status === 200 ? { success: true, data } : { success: false, error: data },
    { status },
  );
const args = {
  resource: "departments" as const,
  params: { page: 1, pageSize: 25 },
};

beforeEach(() => {
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
});
afterEach(() => {
  stores.splice(0).forEach(clearWorkspaceData);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("request-safe RTK Query store", () => {
  it("deduplicates subscriptions, includes filters in keys, and keeps store instances isolated", async () => {
    const fetch = vi.fn(async () =>
      response({
        items: [{ id: "dept-a", name: "A" }],
        total: 1,
        page: 1,
        pageSize: 25,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const first = store();
    const second = store();
    const one = first.dispatch(
      managementApi.endpoints.getManagement.initiate(args),
    );
    const two = first.dispatch(
      managementApi.endpoints.getManagement.initiate(args),
    );
    await Promise.all([one, two]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Object.keys(second.getState().workspaceApi.queries)).toHaveLength(0);
    await first.dispatch(
      managementApi.endpoints.getManagement.initiate({
        ...args,
        params: { ...args.params, q: "other", page: 2 },
      }),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(Object.keys(first.getState().workspaceApi.queries)).toHaveLength(2);
    one.unsubscribe();
    two.unsubscribe();
  });

  it("uses no-store cookie requests and keeps previous values only during a same-key refresh", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request);
        return response({ items: [], total: 0, page: 1, pageSize: 25 });
      }),
    );
    const current = store();
    const query = current.dispatch(
      managementApi.endpoints.getManagement.initiate(args),
    );
    await query;
    await query.refetch();
    expect(requests).toHaveLength(2);
    expect(requests[0].cache).toBe("no-store");
    expect(requests[0].credentials).toBe("same-origin");
    expect(requests[0].url).toContain(
      "/api/admin/departments?page=1&pageSize=25",
    );
    query.unsubscribe();
  });

  it("clears data on expiry, fences late responses and does not leak to a new identity", async () => {
    let resolveOld!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((request: Request) => {
        if (request.url.includes("q=slow"))
          return new Promise<Response>((resolve) => {
            resolveOld = resolve;
          });
        if (request.url.includes("q=expired"))
          return Promise.resolve(
            response({ code: "UNAUTHENTICATED", message: "Expired" }, 401),
          );
        return Promise.resolve(
          response({ items: [{ id: "private-old" }], total: 1 }),
        );
      }),
    );
    const old = store();
    await old.dispatch(managementApi.endpoints.getManagement.initiate(args));
    const pending = old.dispatch(
      managementApi.endpoints.getManagement.initiate({
        ...args,
        params: { ...args.params, q: "slow" },
      }),
    );
    await vi.waitFor(() => expect(resolveOld).toBeTypeOf("function"));
    await old.dispatch(
      managementApi.endpoints.getManagement.initiate({
        ...args,
        params: { ...args.params, q: "expired" },
      }),
    );
    expect(old.getState().workspaceUi.status).toBe("expired");
    resolveOld(response({ items: [{ id: "late-private-old" }], total: 1 }));
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.stringify(old.getState())).not.toContain("private-old");
    const next = store();
    expect(next.getState().workspaceUi.status).toBe("active");
    expect(Object.keys(next.getState().workspaceApi.queries)).toHaveLength(0);
  });

  it("does not reset or redirect the whole workspace for resource-specific 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({ code: "FORBIDDEN", message: "Denied" }, 403),
      ),
    );
    const current = store();
    const result = await current.dispatch(
      managementApi.endpoints.getManagement.initiate(args),
    );
    expect(result.error).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(current.getState().workspaceUi.status).toBe("active");
    const view = useQueryView({
      currentData: { private: true },
      isLoading: false,
      isFetching: false,
      error: result.error,
      refetch: vi.fn(),
    });
    expect(view.data).toBeUndefined();
    expect(view.error).toBe("Denied");
  });

  it("never retries a failed write or a rate-limited read and preserves safe field errors", async () => {
    const fetch = vi.fn(async () =>
      response({ code: "RATE_LIMITED", message: "Wait" }, 429),
    );
    vi.stubGlobal("fetch", fetch);
    const current = store();
    await current.dispatch(
      managementApi.endpoints.getManagement.initiate(args),
    );
    await current.dispatch(
      managementApi.endpoints.writeManagement.initiate({
        resource: "departments",
        method: "POST",
        body: { name: "test" },
      }),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      normalizeError(400, {
        error: {
          code: "VALIDATION_ERROR",
          message: "Check fields",
          fieldErrors: { name: ["Required"] },
        },
      }),
    ).toMatchObject({ fieldErrors: { name: ["Required"] } });
    current.dispatch(workspaceClosed("signed-out"));
    await current.dispatch(
      managementApi.endpoints.getManagement.initiate(args),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("treats an unreadable successful write response as uncertain, without replaying it", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("{truncated", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const current = store();
    const result = await current.dispatch(
      managementApi.endpoints.writeManagement.initiate({
        resource: "departments",
        method: "POST",
        body: { name: "test" },
      }),
    );
    expect(result.error).toMatchObject({ status: "PARSING_ERROR" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("distinguishes filter loading and background refresh failure without showing old-filter data", () => {
    const current = useQueryView({
      currentData: undefined,
      isFetching: true,
      isLoading: false,
      refetch: vi.fn(),
    });
    expect(current.data).toBeUndefined();
    expect(current.loading).toBe(true);
    const cached = useQueryView({
      currentData: { total: 4 },
      isFetching: false,
      isLoading: false,
      error: normalizeError("FETCH_ERROR"),
      refetch: vi.fn(),
    });
    expect(cached.data).toEqual({ total: 4 });
    expect(cached.error).toContain("Showing previously loaded data");
  });
});
