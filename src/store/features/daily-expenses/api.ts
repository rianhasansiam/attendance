import { baseApi } from "@/store/api/base-api";
import type {
  BalanceInput,
  CategoryCreateInput,
  CategoryUpdateInput,
  DailyExpenseCategoryDTO,
  DailyExpenseDeletionDTO,
  DailyExpenseHistoryDTO,
  DailyExpenseMutationDTO,
  DailyExpenseSummaryDTO,
  DailyExpenseTransactionDTO,
  ExpenseInput,
  TransactionUpdateInput,
  TransactionDeleteInput,
} from "@/modules/daily-expenses/contracts";

export type DailyExpensesHistoryArgs = {
  page: number;
  pageSize: number;
  from?: string;
  to?: string;
  type?: DailyExpenseTransactionDTO["type"];
  categoryId?: string;
  search?: string;
};

const transactionTags = [
  "DailyExpensesSummary",
  "DailyExpensesTransactions",
] as const;
const categoryTags = ["DailyExpensesCategories"] as const;

export const dailyExpensesApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    dailyExpensesSummary: build.query<DailyExpenseSummaryDTO, void>({
      query: () => "/api/daily-expenses/summary",
      providesTags: ["DailyExpensesSummary"],
    }),
    dailyExpensesTransactions: build.query<
      DailyExpenseHistoryDTO,
      DailyExpensesHistoryArgs
    >({
      query: (params) => ({ url: "/api/daily-expenses/transactions", params }),
      // A shared list tag covers all pages and filtered-list membership.
      providesTags: ["DailyExpensesTransactions"],
    }),
    dailyExpensesCategories: build.query<DailyExpenseCategoryDTO[], void>({
      query: () => "/api/daily-expenses/categories",
      providesTags: categoryTags,
    }),
    addDailyExpensesBalance: build.mutation<
      DailyExpenseMutationDTO,
      BalanceInput
    >({
      query: (body) => ({
        url: "/api/daily-expenses/balance",
        method: "POST",
        body,
      }),
      invalidatesTags: (_result, error) => (error ? [] : transactionTags),
    }),
    addDailyExpense: build.mutation<DailyExpenseMutationDTO, ExpenseInput>({
      query: (body) => ({
        url: "/api/daily-expenses/expenses",
        method: "POST",
        body,
      }),
      invalidatesTags: (_result, error) => (error ? [] : transactionTags),
    }),
    updateDailyExpenseTransaction: build.mutation<
      DailyExpenseMutationDTO,
      { id: string; input: TransactionUpdateInput }
    >({
      query: ({ id, input }) => ({
        url: `/api/daily-expenses/transactions/${encodeURIComponent(id)}`,
        method: "PATCH",
        body: input,
      }),
      invalidatesTags: (_result, error) => (error ? [] : transactionTags),
    }),
    deleteDailyExpenseTransaction: build.mutation<
      DailyExpenseDeletionDTO,
      { id: string; input: TransactionDeleteInput }
    >({
      query: ({ id, input }) => ({
        url: `/api/daily-expenses/transactions/${encodeURIComponent(id)}`,
        method: "DELETE",
        body: input,
      }),
      invalidatesTags: (_result, error) => (error ? [] : transactionTags),
    }),
    createDailyExpenseCategory: build.mutation<
      DailyExpenseCategoryDTO,
      CategoryCreateInput
    >({
      query: (body) => ({
        url: "/api/daily-expenses/categories",
        method: "POST",
        body,
      }),
      invalidatesTags: (_result, error) => (error ? [] : categoryTags),
    }),
    updateDailyExpenseCategory: build.mutation<
      DailyExpenseCategoryDTO,
      { id: string; input: CategoryUpdateInput }
    >({
      query: ({ id, input }) => ({
        url: `/api/daily-expenses/categories/${encodeURIComponent(id)}`,
        method: "PATCH",
        body: input,
      }),
      invalidatesTags: (_result, error) =>
        error ? [] : [...categoryTags, "DailyExpensesTransactions"],
    }),
  }),
});

export const {
  useDailyExpensesSummaryQuery,
  useDailyExpensesTransactionsQuery,
  useDailyExpensesCategoriesQuery,
  useAddDailyExpensesBalanceMutation,
  useAddDailyExpenseMutation,
  useUpdateDailyExpenseTransactionMutation,
  useDeleteDailyExpenseTransactionMutation,
  useCreateDailyExpenseCategoryMutation,
  useUpdateDailyExpenseCategoryMutation,
} = dailyExpensesApi;
