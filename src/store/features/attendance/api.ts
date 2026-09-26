import { baseApi } from "@/store/api/base-api";
import type { AppDispatch, RootState } from "@/store/make-store";
import type {
  AttendanceHistory,
  AttendanceHistoryArgs,
  AttendanceRecord,
  DeviceList,
  EmployeeDay,
  LateApprovalPage,
  LateApprovalQuery,
  LateApprovalRequest,
} from "./contracts";

// Derived from attendance/service, reports/service, and management/workflows.
// Ceremony callers dispatch these safe tags only after the server confirms a write.
export const attendanceChangedTags = [
  { type: "Attendance", id: "HISTORY" },
  { type: "Dashboard", id: "ADMIN_SUMMARY" },
  { type: "Management", id: "events:LIST" },
  "Reports",
  "Audit",
] as const;
export const devicesChangedTags = ["Devices", "Attendance", "Audit"] as const;

export const attendanceApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    employeeDay: build.query<EmployeeDay, void>({
      query: () => "/api/attendance/me",
      providesTags: [
        { type: "Attendance", id: "DAY" },
        { type: "Dashboard", id: "EMPLOYEE_DAY" },
      ],
    }),
    employeeHistory: build.query<AttendanceHistory, AttendanceHistoryArgs>({
      query: (params) => ({ url: "/api/attendance/history", params }),
      providesTags: (result) => [
        { type: "Attendance", id: "HISTORY" },
        ...(result?.records.flatMap(({ id }) =>
          id ? [{ type: "Attendance" as const, id }] : [],
        ) ?? []),
      ],
    }),
    employeeDevices: build.query<DeviceList, { page: number }>({
      query: (params) => ({ url: "/api/webauthn/devices", params }),
      providesTags: (result) => [
        { type: "Devices", id: "OWN_LIST" },
        ...(result?.items.map(({ id }) => ({ type: "Devices" as const, id })) ??
          []),
      ],
    }),
    revokeEmployeeDevice: build.mutation<
      { id: string; revoked: boolean },
      string
    >({
      query: (id) => ({
        url: "/api/webauthn/devices",
        method: "DELETE",
        body: { id },
      }),
      invalidatesTags: (_result, error) => (error ? [] : devicesChangedTags),
    }),
    saveLateReason: build.mutation<
      AttendanceRecord,
      { attendanceId: string; reason: string; requestApproval?: boolean }
    >({
      query: (body) => ({
        url: "/api/attendance/late-reason",
        method: "POST",
        body,
      }),
      invalidatesTags: (_result, error) =>
        error
          ? []
          : [
              "LateApprovals",
              { type: "Attendance", id: "DAY" },
              ...attendanceChangedTags,
            ],
    }),
    lateApprovals: build.query<LateApprovalPage, LateApprovalQuery>({
      query: (params) => ({ url: "/api/admin/late-approvals", params }),
      providesTags: ["LateApprovals"],
    }),
    reviewLateApproval: build.mutation<
      LateApprovalRequest,
      { id: string; status: "APPROVED" | "REJECTED"; reviewNote?: string }
    >({
      query: ({ id, ...body }) => ({
        url: `/api/admin/late-approvals/${encodeURIComponent(id)}`,
        method: "PATCH",
        body,
      }),
      invalidatesTags: (_result, error) =>
        error
          ? []
          : ["LateApprovals", "Attendance", "Dashboard", "Reports", "Audit"],
    }),
  }),
});

// Explicitly copy display fields: even an accidentally expanded server response
// must not send verification evidence into Redux actions or its cache.
function displayRecord(record: AttendanceRecord): AttendanceRecord {
  return {
    id: record.id,
    attendanceDate: record.attendanceDate,
    checkInAt: record.checkInAt,
    checkOutAt: record.checkOutAt,
    status: record.status,
    ...(record.actualStatus !== undefined
      ? { actualStatus: record.actualStatus }
      : {}),
    ...(record.actualLateMinutes !== undefined
      ? { actualLateMinutes: record.actualLateMinutes }
      : {}),
    ...(record.effectiveLateMinutes !== undefined
      ? { effectiveLateMinutes: record.effectiveLateMinutes }
      : {}),
    ...(record.isExcusedLate !== undefined
      ? { isExcusedLate: record.isExcusedLate }
      : {}),
    ...(record.lateApprovalStatus !== undefined
      ? { lateApprovalStatus: record.lateApprovalStatus }
      : {}),
    ...(record.rawOvertimeMinutes !== undefined
      ? { rawOvertimeMinutes: record.rawOvertimeMinutes }
      : {}),
    lateMinutes: record.lateMinutes,
    lateReason: record.lateReason,
    workedMinutes: record.workedMinutes,
    overtimeMinutes: record.overtimeMinutes,
  };
}

/** Call only with a committed POST result. The caller cancels the attempt signal
 * on unmount/session changes and checks its attempt before showing success.
 * No request is issued here: abort settlement only waits for RTK's local thunk.
 */
export function applyConfirmedAttendance(
  record: AttendanceRecord,
  expectedEmployeeId: string,
  signal?: AbortSignal,
) {
  const confirmed = displayRecord(record);
  return async (dispatch: AppDispatch, getState: () => RootState) => {
    const selectDay = () =>
      attendanceApi.endpoints.employeeDay.select(undefined)(getState());
    const original = selectDay();
    const active = () =>
      !signal?.aborted && getState().workspaceUi.status === "active";
    if (
      !active() ||
      !confirmed.id ||
      original.data?.employee.id !== expectedEmployeeId
    )
      return false;

    const running = dispatch(
      attendanceApi.util.getRunningQueryThunk("employeeDay", undefined),
    );
    if (running) {
      // Patching a pending query alone would allow its older snapshot to win.
      // Abort the RTK thunk even if the underlying transport ignores cancellation.
      running.abort();
      await running;
    }

    const current = selectDay();
    // Delayed invalidation can start a replacement GET as the abort settles.
    // It retains this cache entry's data and starts after the POST committed, so
    // its eventual authoritative response is safe. Do not discard confirmation
    // just because that fresh read received a new request ID. A reset/recreated
    // entry or changed identity still fails this guard (and attempt cancellation).
    const sameEntry =
      current.requestId === original.requestId ||
      (current.isLoading && current.data === original.data);
    if (
      !active() ||
      !sameEntry ||
      current.data?.employee.id !== expectedEmployeeId
    )
      return false;

    const recent = current.data.recent.filter(
      (entry) =>
        entry.id !== confirmed.id &&
        entry.attendanceDate.slice(0, 10) !==
          confirmed.attendanceDate.slice(0, 10),
    );
    recent.push(confirmed);
    recent.sort((left, right) =>
      right.attendanceDate.localeCompare(left.attendanceDate),
    );
    // `today` represents the active record, including an overnight record from
    // an earlier attendance date. A later normal read advances the dashboard day.
    // Upserting the merged snapshot also clears the aborted GET's error/status.
    dispatch(
      attendanceApi.util.upsertQueryEntries([
        {
          endpointName: "employeeDay",
          arg: undefined,
          value: {
            ...current.data,
            today: confirmed,
            recent: recent.slice(0, 14),
          },
        },
      ]),
    );
    return true;
  };
}

export const {
  useEmployeeDayQuery,
  useLazyEmployeeDayQuery,
  useEmployeeHistoryQuery,
  useEmployeeDevicesQuery,
  useRevokeEmployeeDeviceMutation,
  useSaveLateReasonMutation,
  useLateApprovalsQuery,
  useReviewLateApprovalMutation,
} = attendanceApi;
