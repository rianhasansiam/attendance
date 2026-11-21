import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { createApi } from "@reduxjs/toolkit/query";

// Use RTK's headless API module to verify the real request/cache configuration
// under the repository's react-server test condition.
let api: typeof import("../src/store/features/office-work/api").officeWorkApi;
let makeStore: typeof import("../src/store/make-store").makeStore;
const OriginalRequest = globalThis.Request;
const originalSetTimeout = globalThis.setTimeout;
const calls: { url: string; method: string; body: unknown }[] = [];
let conflict = false;
before(async () => {
  // RTK 2.12's fetch timeout signal deliberately keeps a 30-second timer after
  // successful requests. Preserve its behavior but don't hold the test process.
  mock.method(globalThis, "setTimeout", ((
    ...args: Parameters<typeof setTimeout>
  ) => {
    const timer = originalSetTimeout(...args);
    if (args[1] === 30_000) timer.unref();
    return timer;
  }) as typeof setTimeout);
  mock.module("@reduxjs/toolkit/query/react", { namedExports: { createApi } });
  globalThis.Request = class extends OriginalRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(
        typeof input === "string" && input.startsWith("/")
          ? `https://office-work.example.test${input}`
          : input,
        init,
      );
    }
  };
  mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof OriginalRequest
          ? input
          : new OriginalRequest(input, init);
      const url = new URL(request.url);
      const body =
        request.method === "GET" ? null : await request.clone().json();
      calls.push({
        url: url.pathname + url.search,
        method: request.method,
        body,
      });
      if (conflict && request.method !== "GET")
        return Response.json(
          {
            success: false,
            error: {
              code: "TASK_CONFLICT",
              message:
                "This task changed. Refresh and review it before trying again.",
            },
          },
          { status: 409 },
        );
      return Response.json({
        success: true,
        data: url.pathname.endsWith("assignees")
          ? []
          : request.method !== "GET"
            ? { id: "task-1", version: 2 }
            : {
                items: [],
                dashboard: { total: 0 },
                workload: [],
                activities: [],
                task: { id: "task-1", version: 2 },
              },
      });
    },
  );
  ({ officeWorkApi: api } =
    await import("../src/store/features/office-work/api"));
  ({ makeStore } = await import("../src/store/make-store"));
});
after(() => {
  globalThis.Request = OriginalRequest;
  mock.restoreAll();
});

async function subscribedStore() {
  const store = makeStore();
  const subscriptions = [
    store.dispatch(
      api.endpoints.officeWork.initiate({ view: "all", page: 1, pageSize: 20 }),
    ),
    store.dispatch(
      api.endpoints.officeWork.initiate({
        view: "mine",
        status: "PENDING",
        page: 1,
        pageSize: 20,
      }),
    ),
    store.dispatch(
      api.endpoints.officeWorkTask.initiate({
        id: "task-1",
        page: 1,
        pageSize: 20,
      }),
    ),
    store.dispatch(
      api.endpoints.officeWorkAssignees.initiate({ search: "Employee" }),
    ),
  ];
  await Promise.all(subscriptions.map((subscription) => subscription.unwrap()));
  return {
    store,
    close() {
      for (const subscription of subscriptions) subscription.unsubscribe();
      store.dispatch(api.util.resetApiState());
    },
  };
}

test("one task mutation refreshes all list scopes, dashboard/workload overview, details and lookup cache", async () => {
  calls.length = 0;
  conflict = false;
  const { store, close } = await subscribedStore();
  try {
    assert.equal(calls.filter((call) => call.method === "GET").length, 4);
    await store
      .dispatch(
        api.endpoints.actOnOfficeWork.initiate({
          id: "task-1",
          input: {
            action: "complete",
            expectedVersion: 1,
            reason: "Administrative handover",
          },
        }),
      )
      .unwrap();
    await Promise.all(store.dispatch(api.util.getRunningQueriesThunk()));
    assert.equal(calls.filter((call) => call.method === "GET").length, 8);
    const write = calls.find((call) => call.method === "POST");
    assert.ok(write);
    assert.equal(write.url, "/api/office-work/task-1/actions");
    assert.deepEqual(write.body, {
      action: "complete",
      expectedVersion: 1,
      reason: "Administrative handover",
    });
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  } finally {
    close();
  }
});

test("stale mutation preserves the conflict code, performs no automatic write retry and reconciles caches", async () => {
  calls.length = 0;
  conflict = false;
  const { store, close } = await subscribedStore();
  try {
    conflict = true;
    await assert.rejects(
      store
        .dispatch(
          api.endpoints.updateOfficeWork.initiate({
            id: "task-1",
            input: {
              expectedVersion: 1,
              title: "Changed task",
              description: null,
              dueDate: "2026-11-21",
              priority: "HIGH",
            },
          }),
        )
        .unwrap(),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, "TASK_CONFLICT");
        assert.equal((error as { status: number }).status, 409);
        return true;
      },
    );
    await Promise.all(store.dispatch(api.util.getRunningQueriesThunk()));
    assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
    assert.equal(calls.filter((call) => call.method === "GET").length, 8);
  } finally {
    conflict = false;
    close();
  }
});
