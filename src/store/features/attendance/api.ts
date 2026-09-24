import { baseApi } from "@/store/api/base-api";
import type {
  AttendanceHistory,
  AttendanceHistoryArgs,
  AttendanceRecord,
  DeviceList,
  EmployeeDay,
} from "./contracts";

// Derived from attendance/service, reports/service, and management/workflows.
// Ceremony callers dispatch these safe tags only after the server confirms a write.
export const attendanceChangedTags = [
  "Attendance",
  "Dashboard",
  "Reports",
  "Audit",
] as const;
export const devicesChangedTags = ["Devices", "Attendance", "Audit"] as const;

export const attendanceApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    employeeDay: build.query<EmployeeDay, void>({
      query: () => "/api/attendance/me",
      providesTags: ["Attendance", "Dashboard"],
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
      { attendanceId: string; reason: string }
    >({
      query: (body) => ({
        url: "/api/attendance/late-reason",
        method: "POST",
        body,
      }),
      invalidatesTags: (_result, error) => (error ? [] : attendanceChangedTags),
    }),
  }),
});

export const {
  useEmployeeDayQuery,
  useLazyEmployeeDayQuery,
  useEmployeeHistoryQuery,
  useEmployeeDevicesQuery,
  useRevokeEmployeeDeviceMutation,
  useSaveLateReasonMutation,
} = attendanceApi;
