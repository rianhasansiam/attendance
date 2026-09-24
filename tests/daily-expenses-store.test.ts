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
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(
      fetch.mock.calls.every(([request]) => request.method !== "GET"),
    ).toBe(true);
    expect(
      dailyExpensesApi.endpoints.dailyExpensesSummary.select()(store.getState())
        .data,
    ).toEqual(summary);
  });

  it.each(["balance", "expense"])(
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
      else
        await store
          .dispatch(
            dailyExpensesApi.endpoints.addDailyExpense.initiate({
              ...submission,
              categoryId: "category",
            }),
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
