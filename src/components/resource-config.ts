type MessageKeys<T> = {
  [Key in keyof T & string]: T[Key] extends string
    ? Key
    : `${Key}.${MessageKeys<T[Key]>}`;
}[keyof T & string];
export type AdminTranslator = (
  key: MessageKeys<typeof import("../../messages/en/admin.json")>,
) => string;
import type { ReactNode } from "react";
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
    render?: (value: unknown, row: DataRow) => ReactNode;
  }[];
  readOnly?: boolean;
  noCreate?: boolean;
  noDelete?: boolean;
};
export function getResourceConfigs(
  t: AdminTranslator,
): Record<string, ResourceConfig> {
  const active: Field = {
    name: "active",
    label: t("labels.active"),
    type: "checkbox",
    default: true,
  };
  const name: Field = { name: "name", label: t("labels.name"), required: true };
  const timezone: Field = {
    name: "timezone",
    label: t("labels.timezone"),
    default: "UTC",
    required: true,
    hint: t("fields.timezoneHint"),
  };
  const office: Field = {
    name: "officeId",
    label: t("labels.office"),
    type: "select",
    resource: "offices",
    required: true,
  };
  const status: Field = {
    name: "status",
    label: t("labels.accountStatus"),
    type: "select",
    options: ["ACTIVE", "INACTIVE", "SUSPENDED"],
    default: "ACTIVE",
    source: "user.status",
  };
  return {
    employees: {
      title: t("labels.usersAndEmployees"),
      singular: t("singular.employees"),
      description: t("resources.employeesDescription"),
      fields: [
        { ...name, source: "user.name" },
        {
          name: "email",
          label: t("labels.email"),
          type: "email",
          required: true,
          source: "user.email",
          hint: t("fields.emailHint"),
        },
        {
          name: "password",
          label: t("labels.applicationPassword"),
          type: "password",
          required: true,
          edit: false,
          minLength: 12,
          maxLength: 128,
          hint: t("fields.passwordHint"),
        },
        {
          name: "confirmPassword",
          label: t("labels.confirmPassword"),
          type: "password",
          required: true,
          edit: false,
          minLength: 12,
          maxLength: 128,
        },
        { name: "employeeCode", label: t("labels.employeeId"), required: true },
        office,
        {
          name: "departmentId",
          label: t("labels.department"),
          type: "select",
          resource: "departments",
        },
        {
          name: "role",
          label: t("labels.role"),
          type: "select",
          options: ["EMPLOYEE", "MANAGE_DRIVER", "ADMIN", "SUPER_ADMIN"],
          default: "EMPLOYEE",
          source: "user.role",
          hint: t("fields.employeeRoleHint"),
        },
        status,
      ],
      columns: [
        { key: "user.name", label: t("labels.name") },
        { key: "employeeCode", label: t("labels.employeeId") },
        { key: "user.email", label: t("labels.email") },
        { key: "department.name", label: t("labels.department") },
        { key: "office.name", label: t("labels.office") },
        { key: "user.role", label: t("labels.role"), format: "badge" },
        { key: "user.status", label: t("labels.status"), format: "badge" },
      ],
      noDelete: true,
    },
    departments: {
      title: t("labels.departments"),
      singular: t("singular.departments"),
      description: t("resources.departmentsDescription"),
      fields: [name, active],
      columns: [
        { key: "name", label: t("labels.department") },
        { key: "active", label: t("labels.active") },
        { key: "createdAt", label: t("labels.created"), format: "date" },
      ],
    },
    offices: {
      title: t("labels.offices"),
      singular: t("singular.offices"),
      description: t("resources.officesDescription"),
      fields: [
        name,
        { name: "address", label: t("labels.address"), required: true },
        {
          name: "latitude",
          label: t("labels.latitude"),
          type: "number",
          required: true,
          min: -90,
          max: 90,
        },
        {
          name: "longitude",
          label: t("labels.longitude"),
          type: "number",
          required: true,
          min: -180,
          max: 180,
        },
        {
          name: "geofenceRadiusMeters",
          label: t("labels.attendanceRadius"),
          type: "number",
          min: 10,
          max: 10000,
          default: 100,
          required: true,
        },
        timezone,
        {
          name: "maximumGpsAccuracyMeters",
          label: t("labels.maximumGpsUncertainty"),
          type: "number",
          min: 1,
          max: 1000,
          default: 50,
          required: true,
        },
        {
          name: "weekendDays",
          label: t("labels.weekendDays"),
          type: "days",
          default: [0, 6],
        },
        {
          name: "requireWebAuthn",
          label: t("labels.requirePasskey"),
          type: "checkbox",
          default: true,
        },
        {
          name: "requireGeofence",
          label: t("labels.requireLocation"),
          type: "checkbox",
          default: true,
        },
        {
          name: "requireOfficeNetwork",
          label: t("labels.requireApprovedNetwork"),
          type: "checkbox",
          default: true,
        },
        {
          name: "requireApprovedDevice",
          label: t("labels.requireAdminApprovedDevice"),
          type: "checkbox",
          default: true,
        },
        active,
      ],
      columns: [
        { key: "name", label: t("labels.office") },
        { key: "address", label: t("labels.address") },
        { key: "timezone", label: t("labels.timezone") },
        { key: "geofenceRadiusMeters", label: t("labels.radius") },
        { key: "active", label: t("labels.active") },
      ],
    },
    networks: {
      title: t("labels.networks"),
      singular: t("singular.networks"),
      description: t("resources.networksDescription"),
      fields: [
        office,
        {
          name: "publicIpOrCidr",
          label: t("labels.publicIp"),
          required: true,
          hint: t("fields.publicIpHint"),
        },
        { name: "description", label: t("labels.description") },
        active,
      ],
      columns: [
        { key: "office.name", label: t("labels.office") },
        { key: "publicIpOrCidr", label: t("labels.publicIpCidr") },
        { key: "description", label: t("labels.description") },
        { key: "active", label: t("labels.active") },
      ],
    },
    shifts: {
      title: t("labels.shifts"),
      singular: t("singular.shifts"),
      description: t("resources.shiftsDescription"),
      fields: [
        name,
        timezone,
        {
          name: "startTime",
          label: t("labels.startTime"),
          type: "time",
          required: true,
        },
        {
          name: "endTime",
          label: t("labels.endTime"),
          type: "time",
          required: true,
          hint: t("fields.overnightHint"),
        },
        {
          name: "graceMinutes",
          label: t("labels.arrivalGrace"),
          type: "number",
          default: 15,
          min: 0,
          max: 180,
          required: true,
        },
        {
          name: "halfDayThreshold",
          label: t("labels.halfDayThreshold"),
          type: "number",
          default: 240,
          min: 1,
          max: 1440,
          required: true,
        },
        active,
      ],
      columns: [
        { key: "name", label: t("labels.shift") },
        { key: "startTime", label: t("labels.start") },
        { key: "endTime", label: t("labels.end") },
        { key: "timezone", label: t("labels.timezone") },
        { key: "graceMinutes", label: t("labels.grace") },
        { key: "active", label: t("labels.active") },
      ],
    },
    assignments: {
      title: t("labels.assignments"),
      singular: t("singular.assignments"),
      description: t("resources.assignmentsDescription"),
      fields: [
        {
          name: "employeeId",
          label: t("labels.employee"),
          type: "select",
          resource: "employees",
          required: true,
        },
        {
          name: "shiftId",
          label: t("labels.shift"),
          type: "select",
          resource: "shifts",
          required: true,
        },
        {
          name: "startDate",
          label: t("labels.effectiveFrom"),
          type: "date",
          required: true,
        },
        {
          name: "endDate",
          label: t("labels.effectiveUntil"),
          type: "date",
          hint: t("fields.ongoingHint"),
        },
      ],
      columns: [
        { key: "employee.user.name", label: t("labels.employee") },
        { key: "shift.name", label: t("labels.shift") },
        { key: "startDate", label: t("labels.from"), format: "date" },
        { key: "endDate", label: t("labels.until"), format: "date" },
      ],
    },
    holidays: {
      title: t("labels.holidays"),
      singular: t("singular.holidays"),
      description: t("resources.holidaysDescription"),
      fields: [
        name,
        { name: "date", label: t("labels.date"), type: "date", required: true },
        {
          ...office,
          required: false,
          hint: t("fields.allOfficesHint"),
        },
      ],
      columns: [
        { key: "name", label: t("labels.holiday") },
        { key: "date", label: t("labels.date"), format: "date" },
        { key: "office.name", label: t("labels.officeAllHint") },
      ],
    },
    users: {
      title: t("labels.users"),
      singular: t("singular.users"),
      description: t("resources.usersDescription"),
      fields: [
        name,
        {
          name: "email",
          label: t("labels.email"),
          type: "email",
          required: true,
          edit: false,
        },
        {
          name: "role",
          label: t("labels.role"),
          type: "select",
          options: ["EMPLOYEE", "MANAGE_DRIVER", "ADMIN", "SUPER_ADMIN"],
          default: "ADMIN",
          required: true,
        },
        { ...status, source: "status" },
      ],
      columns: [
        { key: "name", label: t("labels.name") },
        { key: "email", label: t("labels.email") },
        { key: "role", label: t("labels.role"), format: "badge" },
        { key: "status", label: t("labels.status"), format: "badge" },
      ],
      noCreate: true,
    },
    devices: {
      title: t("labels.devices"),
      singular: t("singular.devices"),
      description: t("resources.devicesDescription"),
      fields: [],
      columns: [
        { key: "employee.user.name", label: t("labels.employee") },
        { key: "name", label: t("labels.device") },
        {
          key: "deviceType",
          label: t("labels.type"),
          render: (value) => auditValueLabel(t, value),
        },
        { key: "approved", label: t("labels.approved") },
        { key: "createdAt", label: t("labels.registered"), format: "date" },
        { key: "revokedAt", label: t("labels.revoked"), format: "date" },
      ],
      noCreate: true,
      noDelete: true,
    },
    leaves: {
      title: t("labels.leaveRequests"),
      singular: t("singular.leaves"),
      description: t("resources.leavesDescription"),
      fields: [],
      columns: [
        { key: "employee.user.name", label: t("labels.employee") },
        { key: "startDate", label: t("labels.from"), format: "date" },
        { key: "endDate", label: t("labels.to"), format: "date" },
        { key: "reason", label: t("labels.reason") },
        { key: "status", label: t("labels.status"), format: "badge" },
      ],
      noCreate: true,
      noDelete: true,
    },
    events: {
      title: t("labels.securityEvents"),
      singular: t("singular.events"),
      description: t("resources.eventsDescription"),
      fields: [],
      columns: [
        { key: "createdAt", label: t("labels.date"), format: "date" },
        { key: "employee.user.name", label: t("labels.employee") },
        {
          key: "type",
          label: t("labels.event"),
          render: (value) => auditValueLabel(t, value),
        },
        { key: "reason", label: t("labels.reason") },
      ],
      readOnly: true,
    },
    audit: {
      title: t("labels.auditLog"),
      singular: t("singular.audit"),
      description: t("resources.auditDescription"),
      fields: [],
      columns: [
        { key: "createdAt", label: t("labels.date"), format: "date" },
        { key: "actor.name", label: t("labels.actor") },
        {
          key: "action",
          label: t("labels.action"),
          render: (value) => auditValueLabel(t, value),
        },
        {
          key: "resource",
          label: t("labels.resource"),
          render: (value) => auditValueLabel(t, value),
        },
        { key: "resourceId", label: t("labels.reference") },
      ],
      readOnly: true,
    },
  };
}
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

/** Translate enum labels while submitting their original API values. */
export function adminOptionLabel(t: AdminTranslator, value: string): string {
  const keys = {
    ACTIVE: "enums.ACTIVE",
    INACTIVE: "enums.INACTIVE",
    SUSPENDED: "enums.SUSPENDED",
    EMPLOYEE: "enums.EMPLOYEE",
    MANAGE_DRIVER: "enums.MANAGE_DRIVER",
    ADMIN: "enums.ADMIN",
    SUPER_ADMIN: "enums.SUPER_ADMIN",
    PRESENT: "enums.PRESENT",
    LATE: "enums.LATE",
    ABSENT: "enums.ABSENT",
    HALF_DAY: "enums.HALF_DAY",
    LEAVE: "enums.LEAVE",
    HOLIDAY: "enums.HOLIDAY",
    WEEKEND: "enums.WEEKEND",
  } as const;
  const key = Object.hasOwn(keys, value)
    ? keys[value as keyof typeof keys]
    : undefined;
  return key ? t(key) : value;
}

/** Only application-owned audit fields use this map; stored user text remains verbatim. */
export function auditValueLabel(t: AdminTranslator, value: unknown): string {
  const keys = {
    DEVICE_REGISTERED: "auditValues.DEVICE_REGISTERED",
    DEVICE_REVOKED: "auditValues.DEVICE_REVOKED",
    DEVICE_APPROVED: "auditValues.DEVICE_APPROVED",
    DEVICE_APPROVAL_REMOVED: "auditValues.DEVICE_APPROVAL_REMOVED",
    CHECK_IN_SUCCESS: "auditValues.CHECK_IN_SUCCESS",
    CHECK_OUT_SUCCESS: "auditValues.CHECK_OUT_SUCCESS",
    CHECK_IN_REJECTED: "auditValues.CHECK_IN_REJECTED",
    CHECK_OUT_REJECTED: "auditValues.CHECK_OUT_REJECTED",
    LATE_REASON_REJECTED: "auditValues.LATE_REASON_REJECTED",
    LATE_REASON_SUBMITTED: "auditValues.LATE_REASON_SUBMITTED",
    LATE_APPROVAL_REQUESTED: "auditValues.LATE_APPROVAL_REQUESTED",
    LATE_APPROVAL_APPROVED: "auditValues.LATE_APPROVAL_APPROVED",
    LATE_APPROVAL_REJECTED: "auditValues.LATE_APPROVAL_REJECTED",
    ADMIN_CORRECTION: "auditValues.ADMIN_CORRECTION",
    DAILY_EXPENSE_TRANSACTION_CREATED:
      "auditValues.DAILY_EXPENSE_TRANSACTION_CREATED",
    DAILY_EXPENSE_TRANSACTION_UPDATED:
      "auditValues.DAILY_EXPENSE_TRANSACTION_UPDATED",
    DAILY_EXPENSE_TRANSACTION_DELETED:
      "auditValues.DAILY_EXPENSE_TRANSACTION_DELETED",
    DAILY_EXPENSE_CATEGORY_CREATED:
      "auditValues.DAILY_EXPENSE_CATEGORY_CREATED",
    DAILY_EXPENSE_CATEGORY_UPDATED:
      "auditValues.DAILY_EXPENSE_CATEGORY_UPDATED",
    DRIVE_COST_BALANCE_ADDED: "auditValues.DRIVE_COST_BALANCE_ADDED",
    DRIVE_COST_CREATED: "auditValues.DRIVE_COST_CREATED",
    DRIVE_COST_UPDATED: "auditValues.DRIVE_COST_UPDATED",
    DRIVE_COST_DELETED: "auditValues.DRIVE_COST_DELETED",
    EMPLOYEE_CREATED: "auditValues.EMPLOYEE_CREATED",
    EMPLOYEE_UPDATED: "auditValues.EMPLOYEE_UPDATED",
    EMPLOYEE_DISABLED: "auditValues.EMPLOYEE_DISABLED",
    EMPLOYEE_DELETED: "auditValues.EMPLOYEE_DELETED",
    DEPARTMENT_CREATED: "auditValues.DEPARTMENT_CREATED",
    DEPARTMENT_UPDATED: "auditValues.DEPARTMENT_UPDATED",
    OFFICE_CREATED: "auditValues.OFFICE_CREATED",
    OFFICE_UPDATED: "auditValues.OFFICE_UPDATED",
    ATTENDANCE_POLICY_MODIFIED: "auditValues.ATTENDANCE_POLICY_MODIFIED",
    NETWORK_CREATED: "auditValues.NETWORK_CREATED",
    NETWORK_UPDATED: "auditValues.NETWORK_UPDATED",
    SHIFT_CREATED: "auditValues.SHIFT_CREATED",
    SHIFT_UPDATED: "auditValues.SHIFT_UPDATED",
    SHIFT_ASSIGNED: "auditValues.SHIFT_ASSIGNED",
    HOLIDAY_CREATED: "auditValues.HOLIDAY_CREATED",
    HOLIDAY_UPDATED: "auditValues.HOLIDAY_UPDATED",
    RECORD_REMOVED: "auditValues.RECORD_REMOVED",
    LEAVE_APPROVED: "auditValues.LEAVE_APPROVED",
    LEAVE_REJECTED: "auditValues.LEAVE_REJECTED",
    ADMINISTRATOR_CREATED: "auditValues.ADMINISTRATOR_CREATED",
    ROLE_CHANGED: "auditValues.ROLE_CHANGED",
    USER_UPDATED: "auditValues.USER_UPDATED",
    USER_DELETED: "auditValues.USER_DELETED",
    GLOBAL_SETTING_UPDATED: "auditValues.GLOBAL_SETTING_UPDATED",
    ATTENDANCE_CORRECTED: "auditValues.ATTENDANCE_CORRECTED",
    PUBLIC_PROFILE_UPDATED: "auditValues.PUBLIC_PROFILE_UPDATED",
    PASSWORD_CHANGED: "auditValues.PASSWORD_CHANGED",
    PASSWORD_SET: "auditValues.PASSWORD_SET",
    LateApprovalRequest: "auditValues.LateApprovalRequest",
    DailyExpenseTransaction: "auditValues.DailyExpenseTransaction",
    DailyExpenseCategory: "auditValues.DailyExpenseCategory",
    DriveCostBalanceAddition: "auditValues.DriveCostBalanceAddition",
    DriveCost: "auditValues.DriveCost",
    Employee: "auditValues.Employee",
    Department: "auditValues.Department",
    Office: "auditValues.Office",
    OfficeNetwork: "auditValues.OfficeNetwork",
    EmployeeShift: "auditValues.EmployeeShift",
    Holiday: "auditValues.Holiday",
    WebAuthnCredential: "auditValues.WebAuthnCredential",
    Leave: "auditValues.Leave",
    User: "auditValues.User",
    SystemSetting: "auditValues.SystemSetting",
    Attendance: "auditValues.Attendance",
    Shift: "auditValues.Shift",
    departments: "auditValues.departments",
    offices: "auditValues.offices",
    networks: "auditValues.networks",
    shifts: "auditValues.shifts",
    assignments: "auditValues.assignments",
    holidays: "auditValues.holidays",
    singleDevice: "auditValues.singleDevice",
    multiDevice: "auditValues.multiDevice",
  } as const;
  const key = Object.hasOwn(keys, String(value))
    ? keys[String(value) as keyof typeof keys]
    : undefined;
  return key ? t(key) : String(value ?? "—");
}
