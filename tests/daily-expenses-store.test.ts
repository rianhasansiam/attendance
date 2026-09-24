import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeStore,
  clearWorkspaceData,
  type AppStore,
} from "@/store/make-store";
import { dailyExpensesApi } from "@/store/features/daily-expenses/api";
import { managementApi } from "@/store/features/management/api";

const NativeRequest = globalThis.Request;
const stores: AppStore[] = [];
const subscriptions: { unsubscribe(): void }[] = [];
const summary = {
  ledger: { id: "ledger", currency: "BDT", timezone: "Asia/Dhaka" },
  currentBalance: "25.00",
  totalBalanceAdded: "100.00",
  totalExpenses: "75.00",
  today: "2026-09-24",
};
const submission = {
  amount: "5.00",
  date: "2026-09-24",
  idempotencyKey: "safe-retry-key-123456",
};
const edit = {
  id: "saved-transaction",
  input: {
    amount: "7.50",
    date: "2026-09-23",
    note: "Corrected amount",
    categoryId: "category",
    expectedVersion: 3,
  },
};
const deletion = { id: edit.id, input: { expectedVersion: 3 } };
const response = (data: unknown, status = 200) =>
  Response.json(
    status === 200
      ? { success: true, data }
      : {
          success: false,
          error: { code: "FAILED", message: "Request failed" },
        },
    { status },
  );
const result = (request: Request) => {
  if (request.url.endsWith("/summary")) return response(summary);
  if (request.url.endsWith("/categories") && request.method === "GET")
    return response([]);
  if (request.method === "DELETE")
    return response({ id: deletion.id, replayed: false });
  if (request.method !== "GET")
    return response({
      transaction: { id: "saved-transaction" },
      replayed: false,
    });
  return response({
    items: [],
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0,
  });
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
  subscriptions.splice(0).forEach((subscription) => subscription.unsubscribe());
  stores.splice(0).forEach(clearWorkspaceData);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function subscribedStore() {
  const store = makeStore();
  stores.push(store);
  const queries = [
    store.dispatch(dailyExpensesApi.endpoints.dailyExpensesSummary.initiate()),
    store.dispatch(
      dailyExpensesApi.endpoints.dailyExpensesTransactions.initiate({
        page: 1,
        pageSize: 20,
      }),
    ),
    store.dispatch(
      dailyExpensesApi.endpoints.dailyExpensesTransactions.initiate({
        page: 3,
        pageSize: 20,
        type: "EXPENSE",
        search: "paper",
      }),
    ),
    store.dispatch(
      dailyExpensesApi.endpoints.dailyExpensesCategories.initiate(),
    ),
    store.dispatch(
      managementApi.endpoints.getManagement.initiate({
        resource: "drive-costs",
        params: { page: 1, pageSize: 20 },
      }),
    ),
    store.dispatch(
      managementApi.endpoints.getManagement.initiate({
        resource: "events",
        params: { page: 1, pageSize: 20 },
      }),
    ),
  ];
  subscriptions.push(...queries);
  await Promise.all(queries);
  return store;
}

describe("Daily Expenses RTK Query isolation and confirmed-save behavior", () => {
  it("does not invalidate any cached queries after rejected financial or category mutations", async () => {
    const fetch = vi.fn(async (request: Request) =>
      request.method === "GET" ? result(request) : response({}, 400),
    );
    vi.stubGlobal("fetch", fetch);
    const store = await subscribedStore();
    fetch.mockClear();
    const operations = [
      store.dispatch(
        dailyExpensesApi.endpoints.addDailyExpensesBalance.initiate(submission),
      ),
      store.dispatch(
        dailyExpensesApi.endpoints.addDailyExpense.initiate({
          ...submission,
          categoryId: "category",
        }),
      ),
      store.dispatch(
        dailyExpensesApi.endpoints.updateDailyExpenseTransaction.initiate(edit),
      ),
      store.dispatch(
        dailyExpensesApi.endpoints.deleteDailyExpenseTransaction.initiate(
          deletion,
        ),
      ),
      store.dispatch(
        dailyExpensesApi.endpoints.createDailyExpenseCategory.initiate({
          name: "Duplicate",
        }),
      ),
      store.dispatch(
        dailyExpensesApi.endpoints.updateDailyExpenseCategory.initiate({
          id: "category",
          input: { archived: true },
        }),
      ),
    ];
    for (const operation of operations)
      expect(await operation).toHaveProperty("error");
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(
      fetch.mock.calls.every(([request]) => request.method !== "GET"),
    ).toBe(true);
    expect(
      dailyExpensesApi.endpoints.dailyExpensesSummary.select()(store.getState())
        .data,
    ).toEqual(summary);
  });

  it.each(["balance", "expense", "edit", "deletion"])(
    "refreshes summary and every active history page after a successful %s",
    async (kind) => {
      const fetch = vi.fn(async (request: Request) => result(request));
      vi.stubGlobal("fetch", fetch);
      const store = await subscribedStore();
      fetch.mockClear();
      if (kind === "balance")
        await store
          .dispatch(
            dailyExpensesApi.endpoints.addDailyExpensesBalance.initiate(
              submission,
            ),
          )
          .unwrap();
      else if (kind === "expense")
        await store
          .dispatch(
            dailyExpensesApi.endpoints.addDailyExpense.initiate({
              ...submission,
              categoryId: "category",
            }),
          )
          .unwrap();
      else if (kind === "edit")
        await store
          .dispatch(
            dailyExpensesApi.endpoints.updateDailyExpenseTransaction.initiate(
              edit,
            ),
          )
          .unwrap();
      else
        await store
          .dispatch(
            dailyExpensesApi.endpoints.deleteDailyExpenseTransaction.initiate(
              deletion,
            ),
          )
          .unwrap();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
      const reads = fetch.mock.calls
        .map(([request]) => request)
        .filter(({ method }) => method === "GET");
      expect(reads.map(({ url }) => new URL(url).pathname).sort()).toEqual([
        "/api/daily-expenses/summary",
        "/api/daily-expenses/transactions",
        "/api/daily-expenses/transactions",
      ]);
      expect(
        reads.some(
          ({ url }) => url.includes("page=3") && url.includes("search=paper"),
        ),
      ).toBe(true);
      expect(
        reads.every(
          ({ cache, credentials }) =>
            cache === "no-store" && credentials === "same-origin",
        ),
      ).toBe(true);
    },
  );

  it.each([
    { kind: "edit", status: 403 },
    { kind: "edit", status: 409 },
    { kind: "deletion", status: 403 },
    { kind: "deletion", status: 409 },
  ])(
    "keeps existing balances and history after $kind is rejected with $status",
    async ({ kind, status }) => {
      const fetch = vi.fn(async (request: Request) =>
        request.method !== "GET" ? response({}, status) : result(request),
      );
      vi.stubGlobal("fetch", fetch);
      const store = await subscribedStore();
      const before = store.getState();
      fetch.mockClear();
      const saved =
        kind === "edit"
          ? await store.dispatch(
              dailyExpensesApi.endpoints.updateDailyExpenseTransaction.initiate(
                edit,
              ),
            )
          : await store.dispatch(
              dailyExpensesApi.endpoints.deleteDailyExpenseTransaction.initiate(
                deletion,
              ),
            );
      expect(saved).toHaveProperty("error.status", status);
      expect(fetch).toHaveBeenCalledOnce();
      expect(
        dailyExpensesApi.endpoints.dailyExpensesSummary.select()(
          store.getState(),
        ).data,
      ).toEqual(summary);
      expect(
        dailyExpensesApi.endpoints.dailyExpensesTransactions.select({
          page: 1,
          pageSize: 20,
        })(store.getState()).data,
      ).toEqual(
        dailyExpensesApi.endpoints.dailyExpensesTransactions.select({
          page: 1,
          pageSize: 20,
        })(before).data,
      );
      const request = fetch.mock.calls[0][0];
      expect(new URL(request.url).pathname).toBe(
        "/api/daily-expenses/transactions/saved-transaction",
      );
      expect(request.method).toBe(kind === "edit" ? "PATCH" : "DELETE");
      expect(await request.clone().json()).toEqual(
        kind === "edit" ? edit.input : deletion.input,
      );
    },
  );

  it.each(["edit", "deletion"])(
    "preserves the authoritative balance while %s is unconfirmed and retries only when explicitly submitted",
    async (kind) => {
      let rejectWrite!: (error: Error) => void;
      let retry = false;
      const fetch = vi.fn((request: Request) => {
        if (request.method === "GET") return Promise.resolve(result(request));
        if (retry)
          return Promise.resolve(
            response(
              kind === "edit"
                ? { transaction: { id: edit.id, version: 4 }, replayed: true }
                : { id: deletion.id, replayed: true },
            ),
          );
        return new Promise<Response>((_resolve, reject) => {
          rejectWrite = reject;
        });
      });
      vi.stubGlobal("fetch", fetch);
      const store = await subscribedStore();
      fetch.mockClear();
      const run = () =>
        kind === "edit"
          ? store.dispatch(
              dailyExpensesApi.endpoints.updateDailyExpenseTransaction.initiate(
                edit,
              ),
            )
          : store.dispatch(
              dailyExpensesApi.endpoints.deleteDailyExpenseTransaction.initiate(
                deletion,
              ),
            );
      const pending = run();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      expect(
        dailyExpensesApi.endpoints.dailyExpensesSummary.select()(
          store.getState(),
        ).data,
      ).toEqual(summary);
      rejectWrite(new Error("Connection lost after mutation"));
      expect(await pending).toHaveProperty("error");
      expect(fetch).toHaveBeenCalledOnce();
      expect(
        dailyExpensesApi.endpoints.dailyExpensesSummary.select()(
          store.getState(),
        ).data,
      ).toEqual(summary);

      retry = true;
      await expect(run().unwrap()).resolves.toMatchObject({ replayed: true });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
      const writes = fetch.mock.calls
        .map(([request]) => request)
        .filter((request) => request.method !== "GET");
      expect(writes).toHaveLength(2);
      expect(await writes[0].clone().json()).toEqual(
        kind === "edit" ? edit.input : deletion.input,
      );
      expect(await writes[1].clone().json()).toEqual(
        kind === "edit" ? edit.input : deletion.input,
      );
    },
  );

  it("invalidates only categories after creation and categories plus histories after category changes", async () => {
    const fetch = vi.fn(async (request: Request) => result(request));
    vi.stubGlobal("fetch", fetch);
    const store = await subscribedStore();
    fetch.mockClear();
    await store
      .dispatch(
        dailyExpensesApi.endpoints.createDailyExpenseCategory.initiate({
          name: "Food",
        }),
      )
      .unwrap();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(
      fetch.mock.calls
        .filter(([request]) => request.method === "GET")
        .map(([request]) => new URL(request.url).pathname),
    ).toEqual(["/api/daily-expenses/categories"]);
    for (const input of [
      { name: "Meals" },
      { archived: true },
      { archived: false },
    ]) {
      await Promise.all(
        store.dispatch(dailyExpensesApi.util.getRunningQueriesThunk()),
      );
      fetch.mockClear();
      await store
        .dispatch(
          dailyExpensesApi.endpoints.updateDailyExpenseCategory.initiate({
            id: "category",
            input,
          }),
        )
        .unwrap();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
      expect(
        fetch.mock.calls
          .filter(([request]) => request.method === "GET")
          .map(([request]) => new URL(request.url).pathname)
          .sort(),
      ).toEqual([
        "/api/daily-expenses/categories",
        "/api/daily-expenses/transactions",
        "/api/daily-expenses/transactions",
      ]);
    }
  });

  it("keeps authoritative balances unchanged until confirmation and does not retry ambiguous writes automatically", async () => {
    let rejectWrite!: (error: Error) => void;
    const fetch = vi.fn((request: Request) =>
      request.method === "POST"
        ? new Promise<Response>((_resolve, reject) => {
            rejectWrite = reject;
          })
        : Promise.resolve(result(request)),
    );
    vi.stubGlobal("fetch", fetch);
    const store = await subscribedStore();
    fetch.mockClear();
    const pending = store.dispatch(
      dailyExpensesApi.endpoints.addDailyExpensesBalance.initiate(submission),
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(
      dailyExpensesApi.endpoints.dailyExpensesSummary.select()(store.getState())
        .data,
    ).toEqual(summary);
    rejectWrite(new Error("Connection lost after request"));
    expect(await pending).toHaveProperty("error");
    expect(fetch).toHaveBeenCalledOnce();
    expect(
      dailyExpensesApi.endpoints.dailyExpensesSummary.select()(store.getState())
        .data,
    ).toEqual(summary);
    expect(
      await (fetch.mock.calls[0][0] as Request).clone().json(),
    ).toMatchObject({ idempotencyKey: submission.idempotencyKey });
  });

  it("keeps a confirmed mutation successful when the subsequent summary refresh fails", async () => {
    let failReads = false;
    const fetch = vi.fn(async (request: Request) =>
      failReads && request.method === "GET"
        ? response({}, 500)
        : result(request),
    );
    vi.stubGlobal("fetch", fetch);
    const store = await subscribedStore();
    fetch.mockClear();
    failReads = true;
    const saved = store.dispatch(
      dailyExpensesApi.endpoints.addDailyExpensesBalance.initiate(submission),
    );
    await expect(saved.unwrap()).resolves.toMatchObject({
      transaction: { id: "saved-transaction" },
    });
    await vi.waitFor(() =>
      expect(
        dailyExpensesApi.endpoints.dailyExpensesSummary.select()(
          store.getState(),
        ).isError,
      ).toBe(true),
    );
    expect(
      dailyExpensesApi.endpoints.dailyExpensesSummary.select()(store.getState())
        .data,
    ).toEqual(summary);
    expect(
      dailyExpensesApi.endpoints.addDailyExpensesBalance.select(
        saved.requestId,
      )(store.getState()),
    ).toMatchObject({ isSuccess: true });
    expect(
      fetch.mock.calls.filter(([request]) => request.method === "POST"),
    ).toHaveLength(1);
  });
});
