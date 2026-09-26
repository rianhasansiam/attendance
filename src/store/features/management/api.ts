import { baseApi } from "@/store/api/base-api";
import type {
  ManagementPage,
  ManagementQuery,
  ManagementRecord,
  ManagementResource,
  ManagementWrite,
  OfficePolicyDefaults,
  ReferencePage,
  ReferenceResource,
  ListParams,
} from "./contracts";

type Domain =
  | "Management"
  | "Reference"
  | "Attendance"
  | "LateApprovals"
  | "Dashboard"
  | "Leave"
  | "Devices"
  | "Reports"
  | "DriveCosts"
  | "Profile"
  | "Audit";
type Tag = { type: Domain; id?: string };
const list = (resource: ManagementResource): Tag => ({
  type: "Management",
  id: `${resource}:LIST`,
});
const scopeDomains: Partial<Record<ManagementResource, Domain>> = {
  devices: "Devices",
  leaves: "Leave",
  "drive-costs": "DriveCosts",
  audit: "Audit",
  events: "Attendance",
};

/** Dependency matrix follows the nested projections and report derivation in
 * management/service, employees/service, and reports/service. List tags also
 * cover membership/order/total changes on pages that do not contain the entity.
 */
const dependencies: Partial<
  Record<
    ManagementResource,
    {
      lists?: ManagementResource[];
      reference?: ReferenceResource;
      domains?: Domain[];
    }
  >
> = {
  employees: {
    lists: ["users", "assignments", "devices", "leaves", "events"],
    reference: "employees",
    domains: [
      "Profile",
      "Attendance",
      "LateApprovals",
      "Dashboard",
      "Reports",
      "Devices",
      "Leave",
    ],
  },
  users: {
    lists: ["employees", "assignments", "devices", "leaves", "events"],
    reference: "employees",
    domains: [
      "Profile",
      "Attendance",
      "LateApprovals",
      "Dashboard",
      "Reports",
      "Devices",
      "Leave",
    ],
  },
  departments: {
    lists: ["employees", "assignments", "leaves", "events"],
    reference: "departments",
    domains: ["Profile", "Dashboard", "Reports"],
  },
  offices: {
    lists: [
      "employees",
      "networks",
      "assignments",
      "leaves",
      "holidays",
      "events",
    ],
    reference: "offices",
    domains: ["Profile", "Attendance", "Dashboard", "Reports"],
  },
  shifts: {
    lists: ["assignments", "employees"],
    reference: "shifts",
    domains: ["Profile", "Attendance", "LateApprovals", "Dashboard", "Reports"],
  },
  assignments: {
    lists: ["employees"],
    domains: ["Profile", "Attendance", "Dashboard", "Reports"],
  },
  networks: { lists: ["offices"], domains: ["Attendance"] },
  holidays: { domains: ["Attendance", "Dashboard", "Reports"] },
  devices: {
    lists: ["employees", "events"],
    domains: ["Devices", "Attendance"],
  },
  leaves: { domains: ["Leave", "Attendance", "Dashboard", "Reports"] },
  "drive-costs": { domains: ["DriveCosts"] },
};

export function managementInvalidation({
  resource,
  id,
}: Pick<ManagementWrite, "resource" | "id">): Tag[] {
  const dependency = dependencies[resource];
  return [
    list(resource),
    ...(id ? [{ type: "Management" as const, id: `${resource}:${id}` }] : []),
    { type: "Audit" },
    ...(dependency?.lists ?? []).map(list),
    ...(dependency?.reference
      ? [{ type: "Reference" as const, id: dependency.reference }]
      : []),
    ...(dependency?.domains ?? []).map((type) => ({ type })),
    ...(resource === "settings"
      ? [{ type: "Management" as const, id: "office-defaults" }]
      : []),
  ];
}

export const managementApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getManagement: build.query<ManagementPage, ManagementQuery>({
      query: ({ resource, params }) => ({
        url: `/api/admin/${resource}`,
        params,
      }),
      providesTags: (result, _error, { resource }) => [
        list(resource),
        ...(scopeDomains[resource] ? [{ type: scopeDomains[resource]! }] : []),
        ...(result?.items ?? []).flatMap((row) =>
          typeof row.id === "string"
            ? [{ type: "Management" as const, id: `${resource}:${row.id}` }]
            : [],
        ),
      ],
    }),
    getReference: build.query<
      ReferencePage,
      { resource: ReferenceResource; params: ListParams }
    >({
      query: ({ resource, params }) => ({
        url: `/api/admin/lookups/${resource}`,
        params,
      }),
      keepUnusedDataFor: 120,
      providesTags: (_result, _error, { resource }) => [
        { type: "Reference", id: resource },
      ],
    }),
    getOfficeDefaults: build.query<OfficePolicyDefaults, void>({
      query: () => "/api/admin/office-defaults",
      providesTags: [{ type: "Management", id: "office-defaults" }],
    }),
    writeManagement: build.mutation<ManagementRecord, ManagementWrite>({
      query: ({ resource, id, method, body }) => ({
        url: `/api/admin/${resource}${id ? `/${encodeURIComponent(id)}` : ""}`,
        method,
        ...(method !== "DELETE" ? { body } : {}),
      }),
      invalidatesTags: (_result, error, arg) =>
        error ? [] : managementInvalidation(arg),
    }),
  }),
});

export const {
  useGetManagementQuery,
  useGetReferenceQuery,
  useLazyGetOfficeDefaultsQuery,
  useWriteManagementMutation,
} = managementApi;
