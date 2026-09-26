import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeStore,
  clearWorkspaceData,
  type AppStore,
} from "@/store/make-store";
import { baseApi } from "@/store/api/base-api";
import {
  applyConfirmedAttendance,
  attendanceApi,
  attendanceChangedTags,
} from "@/store/features/attendance/api";
import type {
  AttendanceRecord,
  EmployeeDay,
} from "@/store/features/attendance/contracts";
import { reportsApi } from "@/store/features/reports/api";
import { managementApi } from "@/store/features/management/api";
import { workspaceClosed } from "@/store/features/workspace-ui/slice";

const NativeRequest = globalThis.Request;
const stores: AppStore[] = [];
const response = (data: unknown) => Response.json({ success: true, data });
const record: AttendanceRecord = {
  id: "attendance-1",
  attendanceDate: "2026-09-24T00:00:00.000Z",
  checkInAt: "2026-09-24T03:20:00.000Z",
  checkOutAt: null,
  status: "LATE",
  lateMinutes: 20,
  lateReason: null,
  workedMinutes: 0,
  overtimeMinutes: 0,
};
const day: EmployeeDay = {
  employee: {
    id: "employee-1",
    employeeCode: "EMP-001",
    user: { name: "Employee", email: "employee@example.test", image: null },
    department: { id: "department-1", name: "Engineering" },
    office: {
      id: "office-1",
      name: "Office",
      address: "Office address",
      timezone: "Asia/Dhaka",
      policy: { requireGeofence: true, requireOfficeNetwork: true },
    },
  },
  shift: {
    id: "shift-1",
    name: "Day shift",
    startTime: "09:00",
    endTime: "17:00",
    timezone: "Asia/Dhaka",
  },
  today: {
    ...record,
    id: undefined,
    checkInAt: null,
    status: "NOT_CHECKED_IN",
  },
  recent: [],
  devices: [
    {
      id: "device-1",
      name: "Laptop",
      approved: true,
      revokedAt: null,
      deviceType: "singleDevice",
      backedUp: false,
      createdAt: "2026-09-01T00:00:00.000Z",
    },
  ],
  network: { verified: true },
  serverTime: "2026-09-24T03:00:00.000Z",
};
function store() {
  const result = makeStore();
  stores.push(result);
  return result;
}
function cachedDay(app: AppStore) {
  return attendanceApi.endpoints.employeeDay.select(undefined)(app.getState());
}
function seed(app: AppStore, value = day) {
  app.dispatch(
    attendanceApi.util.upsertQueryEntries([
      { endpointName: "employeeDay", arg: undefined, value },
    ]),
  );
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
  stores.splice(0).forEach(clearWorkspaceData);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("server-confirmed attendance cache", () => {
  it("retains authoritative approval and effective attendance display fields", async () => {
    const app = store();
    seed(app);
    const confirmed = {
      ...record,
      status: "PRESENT",
      actualStatus: "LATE",
      actualLateMinutes: 20,
      effectiveLateMinutes: 0,
      isExcusedLate: true,
      lateApprovalStatus: "APPROVED" as const,
      rawOvertimeMinutes: 20,
      overtimeMinutes: 0,
    };
    expect(
      await app.dispatch(applyConfirmedAttendance(confirmed, "employee-1")),
    ).toBe(true);
    expect(cachedDay(app).data?.today).toEqual(confirmed);
    expect(cachedDay(app).data?.recent).toEqual([confirmed]);
  });
  it.each(["PRESENT", "LATE"])(
    "renders a %s check-in from its response without a dashboard GET and preserves unrelated data",
    async (status) => {
      const app = store();
      seed(app);
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const confirmed = { ...record, status };
      expect(
        await app.dispatch(applyConfirmedAttendance(confirmed, "employee-1")),
      ).toBe(true);
      const actual = cachedDay(app);
      expect(actual.isSuccess).toBe(true);
      expect(actual.data).toEqual({
        ...day,
        today: confirmed,
        recent: [confirmed],
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("uses the returned ID/date to update an overnight checkout and deduplicate recent history", async () => {
    const app = store();
    const previous = {
      ...record,
      id: "previous",
      attendanceDate: "2026-09-23T00:00:00.000Z",
    };
    const overnight = {
      ...record,
      checkInAt: "2026-09-24T16:00:00.000Z",
      status: "PRESENT",
    };
    seed(app, {
      ...day,
      today: overnight,
      recent: [overnight, previous],
      serverTime: "2026-09-25T01:00:00.000Z",
    });
    const confirmed = {
      ...overnight,
      checkOutAt: "2026-09-25T01:30:00.000Z",
      workedMinutes: 570,
      overtimeMinutes: 90,
    };
    await app.dispatch(applyConfirmedAttendance(confirmed, "employee-1"));
    expect(cachedDay(app).data?.today).toEqual(confirmed);
    expect(cachedDay(app).data?.recent).toEqual([confirmed, previous]);
    // A subsequent normal authoritative read may advance to the next day.
    const nextDay = {
      ...day,
      today: { ...day.today!, attendanceDate: "2026-09-25T00:00:00.000Z" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(nextDay)),
    );
    await app.dispatch(
      attendanceApi.endpoints.employeeDay.initiate(undefined, {
        forceRefetch: true,
      }),
    );
    expect(cachedDay(app).data).toEqual(nextDay);
  });

  it("aborts an older dashboard snapshot locally, clears its AbortError, and ignores an abort-resistant late response", async () => {
    const app = store();
    seed(app);
    let resolveOld!: (value: Response) => void;
    let oldRequest!: Request;
    vi.stubGlobal(
      "fetch",
      vi.fn((request: Request) => {
        oldRequest = request;
        return new Promise<Response>((resolve) => {
          resolveOld = resolve;
        });
      }),
    );
    const oldQuery = app.dispatch(
      attendanceApi.endpoints.employeeDay.initiate(undefined, {
        forceRefetch: true,
      }),
    );
    await vi.waitFor(() => expect(resolveOld).toBeTypeOf("function"));
    // This completes while the transport promise remains unresolved.
    await app.dispatch(applyConfirmedAttendance(record, "employee-1"));
    expect(oldRequest.signal.aborted).toBe(true);
    expect(cachedDay(app).error).toBeUndefined();
    expect(cachedDay(app).isSuccess).toBe(true);
    expect(cachedDay(app).data?.today).toEqual(record);
    resolveOld(response(day));
    await oldQuery;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cachedDay(app).data?.today).toEqual(record);
    expect(cachedDay(app).error).toBeUndefined();
  });

  it("renders confirmation when queued invalidation starts a fresh replacement read during abort settlement", async () => {
    const app = store();
    seed(app);
    const pending: ((value: Response) => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            pending.push(resolve);
          }),
      ),
    );
    const oldQuery = app.dispatch(
      attendanceApi.endpoints.employeeDay.initiate(undefined, {
        forceRefetch: true,
      }),
    );
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    app.dispatch(
      attendanceApi.util.invalidateTags([{ type: "Attendance", id: "DAY" }]),
    );
    expect(
      await app.dispatch(applyConfirmedAttendance(record, "employee-1")),
    ).toBe(true);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    // Neither transport has returned. Confirmation is already usable and the
    // aborted original's error is cleared despite the new query's request ID.
    expect(cachedDay(app).isSuccess).toBe(true);
    expect(cachedDay(app).error).toBeUndefined();
    expect(cachedDay(app).data?.today).toEqual(record);
    pending[0](response(day));
    await oldQuery;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cachedDay(app).data?.today).toEqual(record);

    // The replacement began after the confirmed commit, so its authoritative
    // result may refresh metadata normally without rolling attendance back.
    const refreshed = {
      ...day,
      today: record,
      recent: [record],
      serverTime: "2026-09-24T03:20:01.000Z",
      network: { verified: false },
    };
    pending[1](response(refreshed));
    await vi.waitFor(() => expect(cachedDay(app).data).toEqual(refreshed));
    expect(cachedDay(app).error).toBeUndefined();
  });

  it("dispatches only allowlisted display fields even if the response has extra evidence", async () => {
    const app = store();
    seed(app);
    const upsert = vi.spyOn(attendanceApi.util, "upsertQueryEntries");
    const expanded = {
      ...record,
      latitude: 23.123456,
      ipAddress: "private-ip",
      credentialId: "private-credential",
      response: { authenticatorData: "private-passkey" },
    };
    await app.dispatch(applyConfirmedAttendance(expanded, "employee-1"));
    expect(cachedDay(app).data?.today).toEqual(record);
    expect(JSON.stringify(app.getState())).not.toMatch(
      /private-|latitude|authenticatorData/,
    );
    expect(JSON.stringify(upsert.mock.calls)).not.toMatch(
      /private-|latitude|authenticatorData/,
    );
  });

  it("does not recreate absent data or update a different employee, closed workspace, or cancelled attempt", async () => {
    const app = store();
    expect(
      await app.dispatch(applyConfirmedAttendance(record, "employee-1")),
    ).toBe(false);
    seed(app);
    expect(
      await app.dispatch(applyConfirmedAttendance(record, "employee-2")),
    ).toBe(false);
    const controller = new AbortController();
    controller.abort();
    expect(
      await app.dispatch(
        applyConfirmedAttendance(record, "employee-1", controller.signal),
      ),
    ).toBe(false);
    expect(cachedDay(app).data).toEqual(day);
    app.dispatch(workspaceClosed("signed-out"));
    expect(
      await app.dispatch(applyConfirmedAttendance(record, "employee-1")),
    ).toBe(false);
    expect(cachedDay(app).data).toBeUndefined();
  });

  it("fences a cache reset and recreation while the old query abort is settling", async () => {
    const app = store();
    seed(app);
    let resolveOld!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveOld = resolve;
          }),
      ),
    );
    const oldQuery = app.dispatch(
      attendanceApi.endpoints.employeeDay.initiate(undefined, {
        forceRefetch: true,
      }),
    );
    await vi.waitFor(() => expect(resolveOld).toBeTypeOf("function"));
    const applying = app.dispatch(
      applyConfirmedAttendance(record, "employee-1"),
    );
    clearWorkspaceData(app);
    seed(app);
    expect(await applying).toBe(false);
    expect(cachedDay(app).data).toEqual(day);
    resolveOld(response(day));
    await oldQuery;
  });

  it("keeps a confirmed result when a later background refresh fails", async () => {
    const app = store();
    seed(app);
    await app.dispatch(applyConfirmedAttendance(record, "employee-1"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Offline");
      }),
    );
    const result = await app.dispatch(
      attendanceApi.endpoints.employeeDay.initiate(undefined, {
        forceRefetch: true,
      }),
    );
    expect(result.isError).toBe(true);
    expect(cachedDay(app).data?.today).toEqual(record);
  });
});

describe("selective attendance invalidation", () => {
  it.each(["employees", "users", "shifts"] as const)(
    "refreshes late review employee, reviewer and timezone data after %s changes",
    async (resource) => {
      let reads = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: Request) => {
          if (new URL(request.url).pathname === "/api/admin/late-approvals")
            reads++;
          return response({ items: [], total: 0, page: 1, pageSize: 25 });
        }),
      );
      const app = store();
      await app.dispatch(
        attendanceApi.endpoints.lateApprovals.initiate({
          page: 1,
          pageSize: 25,
        }),
      );
      await app.dispatch(
        managementApi.endpoints.writeManagement.initiate({
          resource,
          id: "changed",
          method: "PATCH",
          body: { name: "Updated" },
        }),
      );
      await vi.waitFor(() => expect(reads).toBe(2));
    },
  );

  it("refreshes active history, summary, report, events and audit queries without refetching the confirmed day or unrelated views", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        requests.push(path);
        if (path === "/api/attendance/me") return response(day);
        if (path === "/api/attendance/history")
          return response({ records: [], total: 0, page: 1, pageSize: 25 });
        return response({ items: [], total: 0, page: 1, pageSize: 25 });
      }),
    );
    const app = store();
    await Promise.all([
      app.dispatch(attendanceApi.endpoints.employeeDay.initiate()),
      app.dispatch(
        attendanceApi.endpoints.employeeHistory.initiate({ page: 1 }),
      ),
      app.dispatch(reportsApi.endpoints.getAdminDashboard.initiate()),
      app.dispatch(
        reportsApi.endpoints.getAdminReport.initiate({ page: 1, pageSize: 25 }),
      ),
      ...(["events", "audit", "departments"] as const).map((resource) =>
        app.dispatch(
          managementApi.endpoints.getManagement.initiate({
            resource,
            params: { page: 1, pageSize: 25 },
          }),
        ),
      ),
    ]);
    await app.dispatch(applyConfirmedAttendance(record, "employee-1"));
    app.dispatch(baseApi.util.invalidateTags([...attendanceChangedTags]));
    await vi.waitFor(() => expect(requests).toHaveLength(12));
    expect(
      requests.filter((path) => path === "/api/attendance/me"),
    ).toHaveLength(1);
    expect(
      requests.filter((path) => path === "/api/admin/departments"),
    ).toHaveLength(1);
    for (const path of [
      "/api/attendance/history",
      "/api/admin/dashboard",
      "/api/admin/reports",
      "/api/admin/events",
      "/api/admin/audit",
    ])
      expect(requests.filter((actual) => actual === path)).toHaveLength(2);
    expect(cachedDay(app).data?.today).toEqual(record);
  });

  it("evicts an inactive history entry so its next subscription must read current data", async () => {
    const fetch = vi.fn(async () =>
      response({ records: [], total: 0, page: 1, pageSize: 25 }),
    );
    vi.stubGlobal("fetch", fetch);
    const app = store();
    const history = app.dispatch(
      attendanceApi.endpoints.employeeHistory.initiate({ page: 1 }),
    );
    await history;
    history.unsubscribe();
    app.dispatch(baseApi.util.invalidateTags([...attendanceChangedTags]));
    expect(
      attendanceApi.endpoints.employeeHistory.select({ page: 1 })(
        app.getState(),
      ).isUninitialized,
    ).toBe(true);
    await app.dispatch(
      attendanceApi.endpoints.employeeHistory.initiate({ page: 1 }),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
