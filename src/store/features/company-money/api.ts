import { baseApi } from "@/store/api/base-api";
import type {
  CompanyMoneyInput,
  CompanyMoneyListArgs,
  CompanyMoneyOverview,
  CompanyMoneyTransactionRecord,
  CompanyMoneyUpdateInput,
  CompanyMoneyDeleteInput,
} from "@/modules/company-money/contracts";

const changedTags = ["CompanyMoney", "Audit"] as const;

export const companyMoneyApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    companyMoney: build.query<CompanyMoneyOverview, CompanyMoneyListArgs>({
      query: (params) => ({ url: "/api/admin/company-money", params }),
      providesTags: ["CompanyMoney"],
    }),
    updateCompanyMoney: build.mutation<
      CompanyMoneyTransactionRecord,
      CompanyMoneyInput
    >({
      query: (input) => ({
        url: "/api/admin/company-money",
        method: "POST",
        body: input,
      }),
      invalidatesTags: (_result, error) => (error ? [] : changedTags),
    }),
    editCompanyMoneyTransaction: build.mutation<
      CompanyMoneyTransactionRecord,
      { id: string; input: CompanyMoneyUpdateInput }
    >({
      query: ({ id, input }) => ({
        url: `/api/admin/company-money/${encodeURIComponent(id)}`,
        method: "PATCH",
        body: input,
      }),
      invalidatesTags: (_result, error) => (error ? [] : changedTags),
    }),
    deleteCompanyMoneyTransaction: build.mutation<
      { id: string },
      { id: string; input: CompanyMoneyDeleteInput }
    >({
      query: ({ id, input }) => ({
        url: `/api/admin/company-money/${encodeURIComponent(id)}`,
        method: "DELETE",
        body: input,
      }),
      invalidatesTags: (_result, error) => (error ? [] : changedTags),
    }),
  }),
});

export const {
  useCompanyMoneyQuery,
  useUpdateCompanyMoneyMutation,
  useEditCompanyMoneyTransactionMutation,
  useDeleteCompanyMoneyTransactionMutation,
} = companyMoneyApi;
