/** JSON-only contracts for the catalog API; never import server services here. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = { [key: string]: JsonValue };
export type ManagementResource =
  | "employees"
  | "departments"
  | "offices"
  | "networks"
  | "shifts"
  | "assignments"
  | "devices"
  | "leaves"
  | "holidays"
  | "drive-costs"
  | "users"
  | "settings"
  | "audit"
  | "events";
export type ReferenceResource =
  "employees" | "departments" | "offices" | "shifts";
export type ListParams = { page: number; pageSize: number; q?: string };
export type PageDto<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

// Catalog forms are defined by resource-config. Values remain JSON at this
// boundary: ISO date strings, and decimal strings for exact monetary values.
export type ManagementRecord = JsonRecord;
export type ManagementPage = PageDto<ManagementRecord>;
export type ReferenceOption = {
  id: string;
  name?: string;
  employeeCode?: string;
  user?: { name: string | null };
};
export type ReferencePage = PageDto<ReferenceOption>;
export type ManagementQuery = {
  resource: ManagementResource;
  params: ListParams;
};
export type ManagementWrite = {
  resource: ManagementResource;
  id?: string;
  method: "POST" | "PATCH" | "DELETE";
  body: JsonRecord;
};
export type OfficePolicyDefaults = {
  requireWebAuthn: boolean;
  requireGeofence: boolean;
  requireOfficeNetwork: boolean;
  requireApprovedDevice: boolean;
  maximumGpsAccuracyMeters: number;
};
