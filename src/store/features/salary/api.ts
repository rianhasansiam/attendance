import { baseApi } from "@/store/api/base-api";
import type {
  SalaryCalculateInput,
  SalaryCalculationDTO,
  SalaryEmployeePageDTO,
  SalaryQuery,
  SalarySettingsDTO,
  SalarySettingsInput,
} from "@/modules/salary/contracts";

export const salaryApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    salaryEmployees: build.query<
      SalaryEmployeePageDTO,
      Omit<SalaryQuery, "period"> & { period?: string }
    >({
      query: (params) => ({ url: "/api/admin/salary", params }),
      providesTags: [
        "Salary",
        { type: "Management", id: "employees:LIST" },
        { type: "Management", id: "settings:LIST" },
        { type: "Reference", id: "departments" },
        { type: "Reference", id: "offices" },
      ],
      // Confidential payroll data follows the workspace session lifecycle.
      keepUnusedDataFor: 0,
    }),
    saveSalarySettings: build.mutation<
      SalarySettingsDTO,
      SalarySettingsInput & { employeeId: string }
    >({
      query: (body) => ({
        url: "/api/admin/salary/settings",
        method: "POST",
        body,
      }),
      invalidatesTags: (_result, error) => (error ? [] : ["Salary", "Audit"]),
    }),
    calculateSalary: build.mutation<
      { items: SalaryCalculationDTO[] },
      SalaryCalculateInput
    >({
      query: (body) => ({
        url: "/api/admin/salary/calculate",
        method: "POST",
        body,
      }),
    }),
  }),
});

export const {
  useSalaryEmployeesQuery,
  useSaveSalarySettingsMutation,
  useCalculateSalaryMutation,
} = salaryApi;
