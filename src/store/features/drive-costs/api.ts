import { baseApi } from "@/store/api/base-api";
import type { DriveCostRateType } from "@/modules/drive-costs/rates";

export type DriveCostPaymentStatus = "UNPAID" | "PAID";

export type DriveCostRecord = {
  id: string;
  date: string;
  destinationFrom: string;
  destinationTo: string;
  kilometers: string;
  isRoundTrip: boolean;
  rateType: DriveCostRateType;
  paymentStatus: DriveCostPaymentStatus;
  ratePerKilometer: string;
  totalCost: string;
};
export type DriveCostList = {
  items: DriveCostRecord[];
  total: number;
  page: number;
  pageSize: number;
};
export type DriveCostListArgs = {
  page: number;
  pageSize: number;
  q: string;
  from?: string;
  to?: string;
  paymentStatus?: DriveCostPaymentStatus;
};
export type DriveCostInput = {
  date: string;
  destinationFrom: string;
  destinationTo: string;
  // Existing validated API input (at most two decimal places); calculations
  // and persisted values remain Prisma Decimal on the server.
  kilometers: number;
  isRoundTrip: boolean;
  rateType: DriveCostRateType;
};
export type CalculationArgs = {
  from: string;
  to?: string;
  paymentStatus?: DriveCostPaymentStatus;
};
type CalculationGroup = {
  records: number;
  kilometers: string;
  totalCost: string;
};
export type DriveCostCalculation = {
  dateFrom: string;
  dateTo: string;
  isSingleDay: boolean;
  paymentStatus: DriveCostPaymentStatus | null;
  totalRecords: number;
  totalKilometers: string;
  totalCost: string;
  breakdown: { inTime: CalculationGroup; overTime: CalculationGroup };
  records: DriveCostRecord[];
};
export type DriveCostBalance = {
  balance: string;
  totalAdded: string;
  totalPaid: string;
};
export type AddDriveCostBalanceInput = {
  requestId: string;
  amount: string;
  note?: string;
};
type DriveCostBalanceAddition = {
  id: string;
  amount: string;
  note: string | null;
  createdAt: string;
};
const changedTags = ["DriveCosts", "Audit"] as const;

export const driveCostsApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    driveCosts: build.query<DriveCostList, DriveCostListArgs>({
      query: (params) => ({ url: "/api/admin/drive-costs", params }),
      providesTags: (result) => [
        { type: "DriveCosts", id: "LIST" },
        ...(result?.items.map(({ id }) => ({
          type: "DriveCosts" as const,
          id,
        })) ?? []),
      ],
    }),
    driveCostCalculation: build.query<DriveCostCalculation, CalculationArgs>({
      query: (params) => ({ url: "/api/admin/drive-costs/calculate", params }),
      providesTags: (result) => [
        { type: "DriveCosts", id: "CALCULATION" },
        ...(result?.records.map(({ id }) => ({
          type: "DriveCosts" as const,
          id,
        })) ?? []),
      ],
    }),
    driveCostBalance: build.query<DriveCostBalance, void>({
      query: () => "/api/admin/drive-costs/balance",
      providesTags: [{ type: "DriveCosts", id: "BALANCE" }],
    }),
    addDriveCostBalance: build.mutation<
      DriveCostBalanceAddition,
      AddDriveCostBalanceInput
    >({
      query: (input) => ({
        url: "/api/admin/drive-costs/balance",
        method: "POST",
        body: input,
      }),
      invalidatesTags: (_result, error) => (error ? [] : changedTags),
    }),
    saveDriveCost: build.mutation<
      DriveCostRecord,
      { id?: string; input: DriveCostInput }
    >({
      query: ({ id, input }) => ({
        url: `/api/admin/drive-costs${id ? `/${encodeURIComponent(id)}` : ""}`,
        method: id ? "PATCH" : "POST",
        body: input,
      }),
      invalidatesTags: (_result, error) => (error ? [] : changedTags),
    }),
    deleteDriveCost: build.mutation<{ id: string }, string>({
      query: (id) => ({
        url: `/api/admin/drive-costs/${encodeURIComponent(id)}`,
        method: "DELETE",
      }),
      invalidatesTags: (_result, error) => (error ? [] : changedTags),
    }),
    updateDriveCostPayment: build.mutation<
      DriveCostRecord,
      { id: string; paymentStatus: "PAID" | "UNPAID" }
    >({
      query: ({ id, paymentStatus }) => ({
        url: `/api/admin/drive-costs/${encodeURIComponent(id)}/payment-status`,
        method: "PATCH",
        body: { paymentStatus },
      }),
      invalidatesTags: (_result, error) => (error ? [] : changedTags),
    }),
  }),
});

export const {
  useDriveCostsQuery,
  useDriveCostCalculationQuery,
  useDriveCostBalanceQuery,
  useAddDriveCostBalanceMutation,
  useSaveDriveCostMutation,
  useDeleteDriveCostMutation,
  useUpdateDriveCostPaymentMutation,
} = driveCostsApi;
