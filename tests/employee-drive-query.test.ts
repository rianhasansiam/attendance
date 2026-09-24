import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearWorkspaceData,
  makeStore,
  type AppStore,
} from "@/store/make-store";
import {
  attendanceApi,
  attendanceChangedTags,
} from "@/store/features/attendance/api";
import { driveCostsApi } from "@/store/features/drive-costs/api";
import { leaveApi } from "@/store/features/leave/api";
import { reportsApi } from "@/store/features/reports/api";
import { baseApi } from "@/store/api/base-api";

const NativeRequest = globalThis.Request;
const stores: AppStore[] = [];
const calls: { path: string; method: string }[] = [];
let failWrite = false;
const record = {
  id: "drive-one",
  date: "2026-09-24",
  destinationFrom: "Office",
  destinationTo: "Site",
  kilometers: "0.01",
  isRoundTrip: true,
  rateType: "IN_TIME",
  paymentStatus: "UNPAID",
  ratePerKilometer: "12.50",
  totalCost: "0.25",
};
beforeEach(() => {
  failWrite = false;
  calls.length = 0;
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
      calls.push({ path: url.pathname, method: request.method });
      if (request.method !== "GET") {
        if (failWrite)
          return Response.json(
            {
              success: false,
              error: { code: "CONFLICT", message: "Changed by another user." },
            },
            { status: 409 },
          );
        return Response.json({ success: true, data: record });
      }
      return Response.json({
        success: true,
        data: {
          items: [record],
          records: [record],
          total: 1,
          page: 1,
          pageSize: 25,
          dateFrom: url.searchParams.get("from"),
          totalCost: "9007199254740993.25",
        },
      });
    }),
  );
});
afterEach(() => {
  stores.splice(0).forEach(clearWorkspaceData);
  vi.unstubAllGlobals();
});
function store() {
  const app = makeStore();
  stores.push(app);
  return app;
}
function reads(path: string) {
  return calls.filter((call) => call.path === path && call.method === "GET")
    .length;
}

describe("employee and drive-cost invalidation", () => {
  it("refreshes every active drive list and calculation once after payment confirmation, preserving exact decimal strings", async () => {
    const app = store();
    const listArgs = { page: 1, pageSize: 25, q: "Office" };
    const calcArgs = { from: "2026-09-24" };
    await Promise.all([
      app.dispatch(driveCostsApi.endpoints.driveCosts.initiate(listArgs)),
      app.dispatch(
        driveCostsApi.endpoints.driveCostCalculation.initiate(calcArgs),
      ),
      app.dispatch(
        driveCostsApi.endpoints.driveCostCalculation.initiate({
          from: "2026-09-01",
          to: "2026-09-24",
        }),
      ),
      app.dispatch(
        attendanceApi.endpoints.employeeHistory.initiate({ page: 1 }),
      ),
    ]);
    await app
      .dispatch(
        driveCostsApi.endpoints.updateDriveCostPayment.initiate({
          id: record.id,
          paymentStatus: "PAID",
        }),
      )
      .unwrap();
    await vi.waitFor(() => {
      expect(reads("/api/admin/drive-costs")).toBe(2);
      expect(reads("/api/admin/drive-costs/calculate")).toBe(4);
    });
    expect(reads("/api/attendance/history")).toBe(1);
    expect(
      driveCostsApi.endpoints.driveCostCalculation.select(calcArgs)(
        app.getState(),
      ).data?.totalCost,
    ).toBe("9007199254740993.25");
    expect(
      driveCostsApi.endpoints.driveCosts.select(listArgs)(app.getState()).data
        ?.items[0].kilometers,
    ).toBe("0.01");
  });

  it("does not invalidate or retry rejected financial writes", async () => {
    const app = store();
    await app.dispatch(
      driveCostsApi.endpoints.driveCosts.initiate({
        page: 1,
        pageSize: 25,
        q: "",
      }),
    );
    failWrite = true;
    await expect(
      app
        .dispatch(
          driveCostsApi.endpoints.updateDriveCostPayment.initiate({
            id: record.id,
            paymentStatus: "PAID",
          }),
        )
        .unwrap(),
    ).rejects.toMatchObject({ status: 409 });
    expect(calls.filter(({ method }) => method === "PATCH")).toHaveLength(1);
    expect(reads("/api/admin/drive-costs")).toBe(1);
  });

  it("refreshes leave-dependent attendance and report views after employee leave changes", async () => {
    const app = store();
    await Promise.all([
      app.dispatch(leaveApi.endpoints.employeeLeaves.initiate({ page: 1 })),
      app.dispatch(attendanceApi.endpoints.employeeDay.initiate()),
      app.dispatch(
        reportsApi.endpoints.getAdminReport.initiate({ page: 1, pageSize: 25 }),
      ),
    ]);
    await app
      .dispatch(
        leaveApi.endpoints.createEmployeeLeave.initiate({
          startDate: "2026-10-01",
          endDate: "2026-10-02",
          reason: "Family event",
        }),
      )
      .unwrap();
    await vi.waitFor(() => {
      expect(reads("/api/employee/leaves")).toBe(2);
      expect(reads("/api/attendance/me")).toBe(2);
      expect(reads("/api/admin/reports")).toBe(2);
    });
  });

  it("refreshes attendance and readiness after safe ceremony invalidation and device revocation", async () => {
    const app = store();
    await Promise.all([
      app.dispatch(attendanceApi.endpoints.employeeDay.initiate()),
      app.dispatch(
        attendanceApi.endpoints.employeeHistory.initiate({
          page: 1,
          from: "2026-09-01",
        }),
      ),
      app.dispatch(
        attendanceApi.endpoints.employeeDevices.initiate({ page: 1 }),
      ),
    ]);
    app.dispatch(baseApi.util.invalidateTags([...attendanceChangedTags]));
    await vi.waitFor(() => expect(reads("/api/attendance/history")).toBe(2));
    await app
      .dispatch(
        attendanceApi.endpoints.revokeEmployeeDevice.initiate("device-one"),
      )
      .unwrap();
    await vi.waitFor(() => {
      expect(reads("/api/attendance/me")).toBe(3);
      expect(reads("/api/webauthn/devices")).toBe(2);
    });
  });
});
