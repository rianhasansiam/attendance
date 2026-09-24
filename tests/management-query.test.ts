import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeStore, type AppStore } from "@/store/make-store";
import { baseApi } from "@/store/api/base-api";
import { managementApi } from "@/store/features/management/api";
import { reportsApi } from "@/store/features/reports/api";

const NativeRequest = globalThis.Request;
const requests: { url: URL; method: string }[] = [];
let stores: AppStore[] = [];
let failCorrection = false;

beforeEach(() => {
  requests.length = 0;
  stores = [];
  failCorrection = false;
  // Browsers resolve same-origin request URLs; Node's Request requires a base.
  vi.stubGlobal(
    "Request",
    class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(
          typeof input === "string"
            ? new URL(input, "https://attendance.test")
            : input,
          init,
        );
      }
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      requests.push({ url, method: request.method });
      if (request.method !== "GET") {
        if (failCorrection)
          return Response.json(
            {
              success: false,
              error: {
                code: "FORBIDDEN",
                message: "Super administrator access required.",
              },
            },
            { status: 403 },
          );
        return Response.json({
          success: true,
          data: {
            id: "changed",
            checkInLatitude: 23.12345,
            checkInCredentialId: "private-evidence",
          },
        });
      }
      return Response.json({
        success: true,
        data: {
          items: [{ id: "item", name: "Sample" }],
          total: 1,
          page: Number(url.searchParams.get("page") || 1),
          pageSize: 25,
          summary: { overtimeMinutes: 0, unknownOvertimeRecords: 0 },
        },
      });
    }),
  );
});
afterEach(() => {
  for (const store of stores) store.dispatch(baseApi.util.resetApiState());
  vi.unstubAllGlobals();
});
function store() {
  const created = makeStore();
  stores.push(created);
  return created;
}
function count(path: string) {
  return requests.filter(
    ({ url, method }) => url.pathname === path && method === "GET",
  ).length;
}

// Exercise real RTK Query subscriptions and invalidation, not a duplicate tag map.
describe("management/report cache dependencies", () => {
  it("refreshes department projections after a write without refetching unrelated reference options", async () => {
    const app = store();
    const params = { page: 1, pageSize: 25 };
    await Promise.all([
      app.dispatch(
        managementApi.endpoints.getManagement.initiate({
          resource: "departments",
          params,
        }),
      ),
      app.dispatch(
        managementApi.endpoints.getManagement.initiate({
          resource: "employees",
          params,
        }),
      ),
      app.dispatch(
        managementApi.endpoints.getReference.initiate({
          resource: "departments",
          params,
        }),
      ),
      app.dispatch(
        managementApi.endpoints.getReference.initiate({
          resource: "offices",
          params,
        }),
      ),
      app.dispatch(
        reportsApi.endpoints.getAdminReport.initiate({
          ...params,
          departmentId: "department-one",
        }),
      ),
    ]);
    await app
      .dispatch(
        managementApi.endpoints.writeManagement.initiate({
          resource: "departments",
          id: "item",
          method: "PATCH",
          body: { name: "Renamed" },
        }),
      )
      .unwrap();
    await vi.waitFor(() => {
      expect(count("/api/admin/departments")).toBe(2);
      expect(count("/api/admin/employees")).toBe(2);
      expect(count("/api/admin/lookups/departments")).toBe(2);
      expect(count("/api/admin/reports")).toBe(2);
    });
    expect(count("/api/admin/lookups/offices")).toBe(1);
  });

  it("keeps report date/employee/page keys separate and invalidates all subscribed scopes after a correction", async () => {
    const app = store();
    const first = {
      employeeId: "employee-one",
      from: "2026-09-01",
      to: "2026-09-24",
      page: 1,
      pageSize: 25,
    };
    const second = { ...first, employeeId: "employee-two", page: 2 };
    await Promise.all([
      app.dispatch(reportsApi.endpoints.getAdminReport.initiate(first)),
      app.dispatch(reportsApi.endpoints.getAdminReport.initiate(second)),
      app.dispatch(reportsApi.endpoints.getAdminDashboard.initiate()),
    ]);
    expect(count("/api/admin/reports")).toBe(2);
    const data = await app
      .dispatch(
        reportsApi.endpoints.correctAttendance.initiate({
          id: "attendance-one",
          body: {
            reason: "Correct missed check out",
            status: "PRESENT",
            checkInAt: null,
            checkOutAt: null,
          },
        }),
      )
      .unwrap();
    await vi.waitFor(() => {
      expect(count("/api/admin/reports")).toBe(4);
      expect(count("/api/admin/dashboard")).toBe(2);
    });
    expect(data).toEqual({ id: "changed" });
    expect(JSON.stringify(app.getState())).not.toContain("private-evidence");
    expect(
      reportsApi.endpoints.getAdminReport.select(first)(app.getState()).data
        ?.page,
    ).toBe(1);
    expect(
      reportsApi.endpoints.getAdminReport.select(second)(app.getState()).data
        ?.page,
    ).toBe(2);
  });

  it("does not refetch a report or automatically retry a denied correction", async () => {
    const app = store();
    await app.dispatch(
      reportsApi.endpoints.getAdminReport.initiate({ page: 1, pageSize: 25 }),
    );
    failCorrection = true;
    await expect(
      app
        .dispatch(
          reportsApi.endpoints.correctAttendance.initiate({
            id: "attendance-one",
            body: {
              reason: "Correct missed check out",
              status: "PRESENT",
              checkInAt: null,
              checkOutAt: null,
            },
          }),
        )
        .unwrap(),
    ).rejects.toMatchObject({ status: 403 });
    expect(count("/api/admin/reports")).toBe(1);
    expect(requests.filter(({ method }) => method === "PATCH")).toHaveLength(1);
  });
});
