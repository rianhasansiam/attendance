import { baseApi } from "@/store/api/base-api";
import type {
  WorkReportAuthor,
  WorkReportCreateInput,
  WorkReportDeleteInput,
  WorkReportDeletionDTO,
  WorkReportDTO,
  WorkReportFeedDTO,
  WorkReportListInput,
  WorkReportUpdateInput,
} from "@/modules/work-report/contracts";

const tags = ["WorkReport"] as const;
export const workReportApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    workReportFeed: build.query<WorkReportFeedDTO, WorkReportListInput>({
      query: (params) => ({ url: "/api/work-report", params }),
      providesTags: tags,
    }),
    workReport: build.query<WorkReportDTO, string>({
      query: (id) => `/api/work-report/${encodeURIComponent(id)}`,
      providesTags: tags,
    }),
    workReportAuthors: build.query<
      WorkReportAuthor[],
      { search?: string; date?: string }
    >({
      query: (params) => ({ url: "/api/work-report/authors", params }),
      providesTags: tags,
    }),
    createWorkReport: build.mutation<WorkReportDTO, WorkReportCreateInput>({
      query: (body) => ({ url: "/api/work-report", method: "POST", body }),
      // Ambiguous writes are reconciled by reads; they are never auto-replayed.
      invalidatesTags: tags,
    }),
    updateWorkReport: build.mutation<
      WorkReportDTO,
      { id: string; input: WorkReportUpdateInput }
    >({
      query: ({ id, input }) => ({
        url: `/api/work-report/${encodeURIComponent(id)}`,
        method: "PATCH",
        body: input,
      }),
      invalidatesTags: tags,
    }),
    deleteWorkReport: build.mutation<
      WorkReportDeletionDTO,
      { id: string; input: WorkReportDeleteInput }
    >({
      query: ({ id, input }) => ({
        url: `/api/work-report/${encodeURIComponent(id)}`,
        method: "DELETE",
        body: input,
      }),
      invalidatesTags: tags,
    }),
  }),
});
export const {
  useWorkReportFeedQuery,
  useWorkReportQuery,
  useLazyWorkReportQuery,
  useWorkReportAuthorsQuery,
  useCreateWorkReportMutation,
  useUpdateWorkReportMutation,
  useDeleteWorkReportMutation,
} = workReportApi;
