import type { DataRow } from "./ui";
export type Field = {
  name: string;
  label: string;
  type?:
    | "text"
    | "email"
    | "password"
    | "number"
    | "date"
    | "time"
    | "checkbox"
    | "select"
    | "textarea"
    | "days"
    | "datetime-local";
  required?: boolean;
  options?: string[];
  disabledOptions?: string[];
  resource?: string;
  hint?: string;
  default?: string | number | boolean | number[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  source?: string;
  edit?: boolean;
  create?: boolean;
};
export type ResourceConfig = {
  title: string;
  singular: string;
  description: string;
  fields: Field[];
  columns: {
    key: string;
    label: string;
    format?: "date" | "time" | "badge" | "duration";
  }[];
  readOnly?: boolean;
  noCreate?: boolean;
  noDelete?: boolean;
};
const active: Field = {
  name: "active",
  label: "Active",
  type: "checkbox",
  default: true,
};
const name: Field = { name: "name", label: "Name", required: true };
const timezone: Field = {
  name: "timezone",
  label: "Timezone",
  default: "UTC",
  required: true,
  hint: "IANA timezone, for example Asia/Dhaka or Europe/London.",
};
const office: Field = {
  name: "officeId",
  label: "Office",
  type: "select",
  resource: "offices",
  required: true,
};
const status: Field = {
  name: "status",
  label: "Account status",
  type: "select",
  options: ["ACTIVE", "INACTIVE", "SUSPENDED"],
  default: "ACTIVE",
  source: "user.status",
};
export const resourceConfigs: Record<string, ResourceConfig> = {
  employees: {
    title: "Employees",
    singular: "employee",
    description: "The people who make your workplace work.",
    fields: [
      { ...name, source: "user.name" },
      {
        name: "email",
        label: "Email",
        type: "email",
        required: true,
        source: "user.email",
        hint: "Used to sign in with a password. For Google sign-in, use the employee’s verified Google email.",
      },
      {
        name: "password",
        label: "Application password",
        type: "password",
        required: true,
        edit: false,
        minLength: 12,
        maxLength: 128,
        hint: "Use 12–128 characters. Long passphrases are welcome.",
      },
      {
        name: "confirmPassword",
        label: "Confirm password",
        type: "password",
        required: true,
        edit: false,
        minLength: 12,
        maxLength: 128,
      },
      { name: "employeeCode", label: "Employee ID", required: true },
      office,
      {
        name: "departmentId",
        label: "Department",
        type: "select",
        resource: "departments",
      },
      {
        name: "role",
        label: "Role",
        type: "select",
        options: ["EMPLOYEE", "MANAGE_DRIVER"],
        default: "EMPLOYEE",
        source: "user.role",
        hint: "Manage driver adds drive cost management to employee access.",
      },
      status,
    ],
    columns: [
      { key: "user.name", label: "Employee" },
      { key: "employeeCode", label: "Employee ID" },
      { key: "user.email", label: "Email" },
      { key: "department.name", label: "Department" },
      { key: "office.name", label: "Office" },
      { key: "user.role", label: "Role", format: "badge" },
      { key: "user.status", label: "Status", format: "badge" },
    ],
    noDelete: true,
  },
  departments: {
    title: "Departments",
    singular: "department",
    description: "Give every team a place in your organization.",
    fields: [name, active],
    columns: [
      { key: "name", label: "Department" },
      { key: "active", label: "Active" },
      { key: "createdAt", label: "Created", format: "date" },
    ],
  },
  offices: {
    title: "Offices",
    singular: "office",
    description: "Your workplaces, their locations, and attendance policies.",
    fields: [
      name,
      { name: "address", label: "Address", required: true },
      {
        name: "latitude",
        label: "Latitude",
        type: "number",
        required: true,
        min: -90,
        max: 90,
      },
      {
        name: "longitude",
        label: "Longitude",
        type: "number",
        required: true,
        min: -180,
        max: 180,
      },
      {
        name: "geofenceRadiusMeters",
        label: "Attendance radius (meters)",
        type: "number",
        min: 10,
        max: 10000,
        default: 100,
        required: true,
      },
      timezone,
      {
        name: "maximumGpsAccuracyMeters",
        label: "Maximum GPS uncertainty (meters)",
        type: "number",
        min: 1,
        max: 1000,
        default: 50,
        required: true,
      },
      {
        name: "weekendDays",
        label: "Weekend days",
        type: "days",
        default: [0, 6],
      },
      {
        name: "requireWebAuthn",
        label: "Require passkey verification",
        type: "checkbox",
        default: true,
      },
      {
        name: "requireGeofence",
        label: "Require office location",
        type: "checkbox",
        default: true,
      },
      {
        name: "requireOfficeNetwork",
        label: "Require approved office network",
        type: "checkbox",
        default: true,
      },
      {
        name: "requireApprovedDevice",
        label: "Require administrator-approved device",
        type: "checkbox",
        default: true,
      },
      active,
    ],
    columns: [
      { key: "name", label: "Office" },
      { key: "address", label: "Address" },
      { key: "timezone", label: "Timezone" },
      { key: "geofenceRadiusMeters", label: "Radius (m)" },
      { key: "active", label: "Active" },
    ],
  },
  networks: {
    title: "Office networks",
    singular: "network",
    description: "Trusted public network addresses for every office.",
    fields: [
      office,
      {
        name: "publicIpOrCidr",
        label: "Public IP address or CIDR",
        required: true,
        hint: "Use the office router’s public IPv4 or IPv6 address.",
      },
      { name: "description", label: "Description" },
      active,
    ],
    columns: [
      { key: "office.name", label: "Office" },
      { key: "publicIpOrCidr", label: "Public IP / CIDR" },
      { key: "description", label: "Description" },
      { key: "active", label: "Active" },
    ],
  },
  shifts: {
    title: "Shifts",
    singular: "shift",
    description: "A clear rhythm for every working day and night.",
    fields: [
      name,
      timezone,
      { name: "startTime", label: "Start time", type: "time", required: true },
      {
        name: "endTime",
        label: "End time",
        type: "time",
        required: true,
        hint: "An earlier end time creates an overnight shift.",
      },
      {
        name: "graceMinutes",
        label: "Arrival grace (minutes)",
        type: "number",
        default: 15,
        min: 0,
        max: 180,
        required: true,
      },
      {
        name: "halfDayThreshold",
        label: "Half-day threshold (minutes)",
        type: "number",
        default: 240,
        min: 1,
        max: 1440,
        required: true,
      },
      active,
    ],
    columns: [
      { key: "name", label: "Shift" },
      { key: "startTime", label: "Start" },
      { key: "endTime", label: "End" },
      { key: "timezone", label: "Timezone" },
      { key: "graceMinutes", label: "Grace (min)" },
      { key: "active", label: "Active" },
    ],
  },
  assignments: {
    title: "Shift assignments",
    singular: "assignment",
    description: "Connect your people with the right working schedule.",
    fields: [
      {
        name: "employeeId",
        label: "Employee",
        type: "select",
        resource: "employees",
        required: true,
      },
      {
        name: "shiftId",
        label: "Shift",
        type: "select",
        resource: "shifts",
        required: true,
      },
      {
        name: "startDate",
        label: "Effective from",
        type: "date",
        required: true,
      },
      {
        name: "endDate",
        label: "Effective until",
        type: "date",
        hint: "Leave empty for an ongoing assignment.",
      },
    ],
    columns: [
      { key: "employee.user.name", label: "Employee" },
      { key: "shift.name", label: "Shift" },
      { key: "startDate", label: "From", format: "date" },
      { key: "endDate", label: "Until", format: "date" },
    ],
  },
  holidays: {
    title: "Holidays",
    singular: "holiday",
    description: "Make space in the calendar for days of rest.",
    fields: [
      name,
      { name: "date", label: "Date", type: "date", required: true },
      {
        ...office,
        required: false,
        hint: "Leave empty to apply to all offices.",
      },
    ],
    columns: [
      { key: "name", label: "Holiday" },
      { key: "date", label: "Date", format: "date" },
      { key: "office.name", label: "Office (— means all)" },
    ],
  },
  users: {
    title: "All Users",
    singular: "user",
    description:
      "Manage every user’s role, account status, and access to your workspace.",
    fields: [
      name,
      {
        name: "email",
        label: "Email",
        type: "email",
        required: true,
        edit: false,
      },
      {
        name: "role",
        label: "Role",
        type: "select",
        options: ["EMPLOYEE", "MANAGE_DRIVER", "ADMIN", "SUPER_ADMIN"],
        default: "ADMIN",
        required: true,
      },
      { ...status, source: "status" },
    ],
    columns: [
      { key: "name", label: "Name" },
      { key: "email", label: "Email" },
      { key: "role", label: "Role", format: "badge" },
      { key: "status", label: "Status", format: "badge" },
    ],
    noCreate: true,
  },
  devices: {
    title: "Devices",
    singular: "device",
    description: "Review the devices your team uses to verify attendance.",
    fields: [],
    columns: [
      { key: "employee.user.name", label: "Employee" },
      { key: "name", label: "Device" },
      { key: "deviceType", label: "Type" },
      { key: "approved", label: "Approved" },
      { key: "createdAt", label: "Registered", format: "date" },
      { key: "revokedAt", label: "Revoked", format: "date" },
    ],
    noCreate: true,
    noDelete: true,
  },
  leaves: {
    title: "Leave requests",
    singular: "leave request",
    description: "A considered view of your team’s time away.",
    fields: [],
    columns: [
      { key: "employee.user.name", label: "Employee" },
      { key: "startDate", label: "From", format: "date" },
      { key: "endDate", label: "To", format: "date" },
      { key: "reason", label: "Reason" },
      { key: "status", label: "Status", format: "badge" },
    ],
    noCreate: true,
    noDelete: true,
  },
  events: {
    title: "Security events",
    singular: "security event",
    description: "Attendance attempts and device verification activity.",
    fields: [],
    columns: [
      { key: "createdAt", label: "Date", format: "date" },
      { key: "employee.user.name", label: "Employee" },
      { key: "type", label: "Event" },
      { key: "reason", label: "Reason" },
    ],
    readOnly: true,
  },
  audit: {
    title: "Audit log",
    singular: "audit entry",
    description: "An accountable record of changes to your workspace.",
    fields: [],
    columns: [
      { key: "createdAt", label: "Date", format: "date" },
      { key: "actor.name", label: "Actor" },
      { key: "action", label: "Action" },
      { key: "resource", label: "Resource" },
      { key: "resourceId", label: "Reference" },
    ],
    readOnly: true,
  },
};
export function fieldValue(row: DataRow, field: Field): unknown {
  let value: unknown = row;
  for (const segment of (field.source || field.name).split("."))
    value =
      value && typeof value === "object"
        ? (value as DataRow)[segment]
        : undefined;
  if (value === undefined) value = field.default ?? "";
  if (field.type === "date" && value) return String(value).slice(0, 10);
  return value;
}
