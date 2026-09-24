import { baseApi } from "@/store/api/base-api";

export type LeaveRecord = {
  id: string;
  employeeId: string;
  startDate: string;
  endDate: string;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  reviewNote: string | null;
};
export type LeaveList = {
  items: LeaveRecord[];
  total: number;
  page: number;
  pageSize: number;
};
export type LeaveInput = { startDate: string; endDate: string; reason: string };
const changedTags = [
  "Leave",
  "Attendance",
  "Dashboard",
  "Reports",
  "Audit",
] as const;

export const leaveApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    employeeLeaves: build.query<LeaveList, { page: number }>({
      query: (params) => ({ url: "/api/employee/leaves", params }),
      providesTags: (result) => [
        { type: "Leave", id: "OWN_LIST" },
        ...(result?.items.map(({ id }) => ({ type: "Leave" as const, id })) ??
          []),
      ],
    }),
    createEmployeeLeave: build.mutation<LeaveRecord, LeaveInput>({
      query: (body) => ({ url: "/api/employee/leaves", method: "POST", body }),
      invalidatesTags: (_result, error) => (error ? [] : changedTags),
    }),
    cancelEmployeeLeave: build.mutation<
      { id: string; status: "CANCELLED" },
      string
    >({
      query: (id) => ({
        url: `/api/employee/leaves/${encodeURIComponent(id)}`,
        method: "DELETE",
      }),
      invalidatesTags: (_result, error) => (error ? [] : changedTags),
    }),
  }),
});

export const {
  useEmployeeLeavesQuery,
  useCreateEmployeeLeaveMutation,
  useCancelEmployeeLeaveMutation,
} = leaveApi;
