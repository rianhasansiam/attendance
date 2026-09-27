import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearWorkspaceData,
  makeStore,
  type AppStore,
} from "@/store/make-store";
import { driveCostsApi } from "@/store/features/drive-costs/api";
import { managementApi } from "@/store/features/management/api";

const NativeRequest = globalThis.Request;
const stores: AppStore[] = [];
const subscriptions: { unsubscribe(): void }[] = [];
const balance = {
  balance: "-50.00",
  totalAdded: "100.00",
  totalPaid: "150.00",
};
const addition = {
  requestId: "550e8400-e29b-41d4-a716-446655440000",
  amount: "125.50",
  note: "Trip budget",
};
const listArgs = { page: 1, pageSize: 25, q: "Office" };
const calcArgs = { from: "2026-09-01", to: "2026-09-30" };

function response(data: unknown, status = 200) {
  return Response.json(
    status === 200
      ? { success: true, data }
      : {
          success: false,
          error: { code: "FAILED", message: "Request failed" },
        },
    { status },
  );
}

function read(request: Request) {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/balance")) return response(balance);
  if (url.pathname.endsWith("/calculate"))
    return response({
      ...calcArgs,
      paymentStatus: url.searchParams.get("paymentStatus"),
      totalRecords: 0,
      totalCost: "0.00",
      records: [],
    });
  return response({ items: [], total: 0, page: 1, pageSize: 25 });
}

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
});

async function subscribedStore() {
  const store = makeStore();
  stores.push(store);
  const queries = [
    ...(["PAID", "UNPAID"] as const).flatMap((paymentStatus) => [
      store.dispatch(
        driveCostsApi.endpoints.driveCosts.initiate({
          ...listArgs,
          paymentStatus,
        }),
      ),
      store.dispatch(
        driveCostsApi.endpoints.driveCostCalculation.initiate({
          ...calcArgs,
          paymentStatus,
        }),
      ),
    ]),
    store.dispatch(driveCostsApi.endpoints.driveCostBalance.initiate()),
    store.dispatch(
      managementApi.endpoints.getManagement.initiate({
        resource: "audit",
        params: { page: 1, pageSize: 20 },
      }),
    ),
  ];
  subscriptions.push(...queries);
  await Promise.all(queries);
  return store;
}

describe("drive cost payment filters and balance cache", () => {
  it("keeps both payment statuses distinct in list and calculation queries, while balance has no filters", async () => {
    const fetch = vi.fn(async (request: Request) => read(request));
    vi.stubGlobal("fetch", fetch);
    const store = await subscribedStore();
    expect(fetch).toHaveBeenCalledTimes(6);
    const requests = fetch.mock.calls.map(([request]) => new URL(request.url));
    for (const paymentStatus of ["PAID", "UNPAID"] as const) {
      expect(
        requests
          .find(
            (url) =>
              url.pathname === "/api/admin/drive-costs" &&
              url.searchParams.get("paymentStatus") === paymentStatus,
          )
          ?.searchParams.get("q"),
      ).toBe("Office");
      expect(
        driveCostsApi.endpoints.driveCostCalculation.select({
          ...calcArgs,
          paymentStatus,
        })(store.getState()).data?.paymentStatus,
      ).toBe(paymentStatus);
    }
    expect(
      requests.find((url) => url.pathname.endsWith("/balance"))?.search,
    ).toBe("");
    expect(
      driveCostsApi.endpoints.driveCostBalance.select()(store.getState()).data,
    ).toEqual(balance);
  });

  it.each(["add balance", "mark paid", "edit trip", "delete trip"])(
    "refreshes the balance, both status filters, calculations and audit after %s",
    async (operation) => {
      const bodies: unknown[] = [];
      const fetch = vi.fn(async (request: Request) => {
        if (request.method === "GET") return read(request);
        if (request.method !== "DELETE") bodies.push(await request.json());
        return response({ id: "record" });
      });
      vi.stubGlobal("fetch", fetch);
      const store = await subscribedStore();
      fetch.mockClear();
      if (operation === "add balance") {
        await store
          .dispatch(
            driveCostsApi.endpoints.addDriveCostBalance.initiate(addition),
          )
          .unwrap();
        expect(bodies).toEqual([addition]);
      } else if (operation === "mark paid") {
        await store
          .dispatch(
            driveCostsApi.endpoints.updateDriveCostPayment.initiate({
              id: "record",
              paymentStatus: "PAID",
            }),
          )
          .unwrap();
      } else if (operation === "edit trip") {
        await store
          .dispatch(
            driveCostsApi.endpoints.saveDriveCost.initiate({
              id: "record",
              input: {
                date: "2026-09-01",
                destinationFrom: "Office",
                destinationTo: "Client",
                kilometers: 15,
                isRoundTrip: true,
                rateType: "IN_TIME",
              },
            }),
          )
          .unwrap();
      } else {
        await store
          .dispatch(driveCostsApi.endpoints.deleteDriveCost.initiate("record"))
          .unwrap();
      }
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(7));
      const refreshed = fetch.mock.calls
        .map(([request]) => request)
        .filter(({ method }) => method === "GET");
      expect(refreshed.map(({ url }) => new URL(url).pathname).sort()).toEqual([
        "/api/admin/audit",
        "/api/admin/drive-costs",
        "/api/admin/drive-costs",
        "/api/admin/drive-costs/balance",
        "/api/admin/drive-costs/calculate",
        "/api/admin/drive-costs/calculate",
      ]);
    },
  );

  it("does not retry a rejected addition or invalidate cached balances", async () => {
    const fetch = vi.fn(async (request: Request) =>
      request.method === "GET" ? read(request) : response({}, 500),
    );
    vi.stubGlobal("fetch", fetch);
    const store = await subscribedStore();
    fetch.mockClear();
    const result = await store.dispatch(
      driveCostsApi.endpoints.addDriveCostBalance.initiate(addition),
    );
    expect(result).toHaveProperty("error");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      driveCostsApi.endpoints.driveCostBalance.select()(store.getState()).data,
    ).toEqual(balance);
  });
});
