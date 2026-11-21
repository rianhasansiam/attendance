import { baseApi } from "@/store/api/base-api";
import type {
  OfficeWorkActionInput,
  OfficeWorkCreateInput,
  OfficeWorkDetailDTO,
  OfficeWorkListInput,
  OfficeWorkOverviewDTO,
  OfficeWorkPerson,
  OfficeWorkTaskDTO,
  OfficeWorkUpdateInput,
} from "@/modules/office-work/contracts";

const tags = ["OfficeWork"] as const;

export const officeWorkApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    officeWork: build.query<OfficeWorkOverviewDTO, OfficeWorkListInput>({
      query: (params) => ({ url: "/api/office-work", params }),
      providesTags: tags,
    }),
    officeWorkTask: build.query<
      OfficeWorkDetailDTO,
      { id: string; page?: number; pageSize?: number }
    >({
      query: ({ id, ...params }) => ({
        url: `/api/office-work/${encodeURIComponent(id)}`,
        params,
      }),
      providesTags: tags,
    }),
    officeWorkAssignees: build.query<OfficeWorkPerson[], { search?: string }>({
      query: (params) => ({ url: "/api/office-work/assignees", params }),
      providesTags: tags,
    }),
    createOfficeWork: build.mutation<OfficeWorkTaskDTO, OfficeWorkCreateInput>({
      query: (body) => ({ url: "/api/office-work", method: "POST", body }),
      // Reconcile even after an ambiguous network response; writes are never retried.
      invalidatesTags: tags,
    }),
    updateOfficeWork: build.mutation<
      OfficeWorkTaskDTO,
      { id: string; input: OfficeWorkUpdateInput }
    >({
      query: ({ id, input }) => ({
        url: `/api/office-work/${encodeURIComponent(id)}`,
        method: "PATCH",
        body: input,
      }),
      invalidatesTags: tags,
    }),
    actOnOfficeWork: build.mutation<
      OfficeWorkTaskDTO,
      { id: string; input: OfficeWorkActionInput }
    >({
      query: ({ id, input }) => ({
        url: `/api/office-work/${encodeURIComponent(id)}/actions`,
        method: "POST",
        body: input,
      }),
      invalidatesTags: tags,
    }),
  }),
});

export const {
  useOfficeWorkQuery,
  useOfficeWorkTaskQuery,
  useOfficeWorkAssigneesQuery,
  useCreateOfficeWorkMutation,
  useUpdateOfficeWorkMutation,
  useActOnOfficeWorkMutation,
} = officeWorkApi;
