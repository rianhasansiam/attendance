import { baseApi } from "@/store/api/base-api";
import type {
  AdminDashboardDto,
  CorrectionWrite,
  ReportPage,
  ReportQuery,
} from "./contracts";

export const reportsApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getAdminDashboard: build.query<AdminDashboardDto, void>({
      query: () => "/api/admin/dashboard",
      providesTags: ["Dashboard"],
    }),
    getAdminReport: build.query<ReportPage, ReportQuery>({
      query: (params) => ({
        url: "/api/admin/reports",
        params: { ...params, format: "json" },
      }),
      providesTags: ["Reports"],
    }),
    correctAttendance: build.mutation<{ id: string }, CorrectionWrite>({
      query: ({ id, body }) => ({
        url: `/api/admin/attendance${id ? `/${encodeURIComponent(id)}` : ""}`,
        method: id ? "PATCH" : "POST",
        body,
      }),
      // The UI needs confirmation only, never historical verification evidence.
      transformResponse: (response: { id: string }) => ({ id: response.id }),
      invalidatesTags: (_result, error) =>
        error ? [] : ["Attendance", "Dashboard", "Reports", "Audit"],
    }),
  }),
});

export const {
  useGetAdminDashboardQuery,
  useGetAdminReportQuery,
  useCorrectAttendanceMutation,
} = reportsApi;
