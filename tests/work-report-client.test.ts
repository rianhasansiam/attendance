import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { createApi } from "@reduxjs/toolkit/query";

// Use RTK's headless API module to verify the real request/cache configuration
// under the repository's react-server test condition.
let api: typeof import("../src/store/features/work-report/api").workReportApi;
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
          ? `https://work-report.example.test${input}`
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
              code: "WORK_REPORT_CONFLICT",
              message:
                "This report changed. Refresh and review it before trying again.",
            },
          },
          { status: 409 },
        );
      return Response.json({
        success: true,
        data: url.pathname.endsWith("assignees")
          ? []
          : request.method !== "GET"
            ? { id: "report-1", version: 2 }
            : {
                items: [],
                dashboard: { total: 0 },
                workload: [],
                activities: [],
                task: { id: "report-1", version: 2 },
              },
      });
    },
  );
  ({ workReportApi: api } =
    await import("../src/store/features/work-report/api"));
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
      api.endpoints.workReportFeed.initiate({ page: 1, pageSize: 20 }),
    ),
    store.dispatch(
      api.endpoints.workReportFeed.initiate({
        page: 1,
        pageSize: 20,
        mine: true,
      }),
    ),
    store.dispatch(
      api.endpoints.workReportFeed.initiate({
        date: "2026-11-20",
        authorId: "author-2",
        search: "handover",
        page: 2,
        pageSize: 20,
      }),
    ),
    store.dispatch(api.endpoints.workReport.initiate("report-1")),
    store.dispatch(
      api.endpoints.workReportAuthors.initiate({
        search: "Manager",
        date: "2026-11-22",
      }),
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

test("create, edit and delete refresh shared/my/historical feeds, report details and author options", async () => {
  calls.length = 0;
  conflict = false;
  const { store, close } = await subscribedStore();
  try {
    assert.equal(calls.filter((call) => call.method === "GET").length, 5);
    const requestId = "c77b9746-bc34-47ab-b055-e95047a4146d";
    await store
      .dispatch(
        api.endpoints.createWorkReport.initiate({
          title: null,
          content: "A daily update",
          requestId,
        }),
      )
      .unwrap();
    await Promise.all(store.dispatch(api.util.getRunningQueriesThunk()));
    assert.equal(calls.filter((call) => call.method === "GET").length, 10);
    assert.deepEqual(
      calls.find((call) => call.method === "POST"),
      {
        url: "/api/work-report",
        method: "POST",
        body: { title: null, content: "A daily update", requestId },
      },
    );
    await store
      .dispatch(
        api.endpoints.updateWorkReport.initiate({
          id: "report-1",
          input: {
            title: "Edited update",
            content: "Revised content",
            expectedVersion: 1,
          },
        }),
      )
      .unwrap();
    await Promise.all(store.dispatch(api.util.getRunningQueriesThunk()));
    assert.equal(calls.filter((call) => call.method === "GET").length, 15);
    assert.deepEqual(calls.find((call) => call.method === "PATCH")?.body, {
      title: "Edited update",
      content: "Revised content",
      expectedVersion: 1,
    });
    await store
      .dispatch(
        api.endpoints.deleteWorkReport.initiate({
          id: "report-1",
          input: { expectedVersion: 2 },
        }),
      )
      .unwrap();
    await Promise.all(store.dispatch(api.util.getRunningQueriesThunk()));
    assert.equal(calls.filter((call) => call.method === "GET").length, 20);
    assert.deepEqual(
      calls.find((call) => call.method === "DELETE"),
      {
        url: "/api/work-report/report-1",
        method: "DELETE",
        body: { expectedVersion: 2 },
      },
    );
  } finally {
    close();
  }
});

test("stale edit returns a clear conflict without replaying the write and revalidates all read scopes", async () => {
  calls.length = 0;
  conflict = false;
  const { store, close } = await subscribedStore();
  try {
    conflict = true;
    await assert.rejects(
      store
        .dispatch(
          api.endpoints.updateWorkReport.initiate({
            id: "report-1",
            input: {
              title: null,
              content: "Preserved draft",
              expectedVersion: 1,
            },
          }),
        )
        .unwrap(),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, "WORK_REPORT_CONFLICT");
        assert.equal((error as { status: number }).status, 409);
        return true;
      },
    );
    await Promise.all(store.dispatch(api.util.getRunningQueriesThunk()));
    assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
    assert.equal(calls.filter((call) => call.method === "GET").length, 10);
  } finally {
    conflict = false;
    close();
  }
});
