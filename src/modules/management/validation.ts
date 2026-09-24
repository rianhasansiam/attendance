import { z } from "zod";
import ipaddr from "ipaddr.js";

export const idSchema = z.string().trim().min(1).max(100);
const label = z.string().trim().min(1).max(160);
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
    );
  }, "Enter a valid calendar date.");
export const timezoneSchema = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, "Enter a valid IANA timezone.");
export const statusSchema = z.enum(["ACTIVE", "INACTIVE", "SUSPENDED"]);
export const attendanceStatusSchema = z.enum([
  "PRESENT",
  "LATE",
  "ABSENT",
  "HALF_DAY",
  "LEAVE",
  "HOLIDAY",
  "WEEKEND",
]);

export const employeeSchema = z
  .object({
    name: label,
    email: z.email().trim().toLowerCase().max(254),
    employeeCode: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z0-9_-]+$/),
    officeId: idSchema,
    departmentId: idSchema.nullable().optional(),
    role: z.enum(["EMPLOYEE", "MANAGE_DRIVER"]).optional(),
    status: statusSchema.default("ACTIVE"),
  })
  .strict();
export const employeeUpdateSchema = employeeSchema
  .partial()
  .extend({ status: statusSchema.optional() })
  .strict();
export const departmentSchema = z
  .object({ name: label, active: z.boolean().default(true) })
  .strict();
export const policySchema = z
  .object({
    requireWebAuthn: z.boolean(),
    requireGeofence: z.boolean(),
    requireOfficeNetwork: z.boolean(),
    requireApprovedDevice: z.boolean(),
    maximumGpsAccuracyMeters: z.number().int().min(1).max(1000),
  })
  .strict();
export const officeSchema = z
  .object({
    name: label,
    address: z.string().trim().min(1).max(500),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    geofenceRadiusMeters: z.number().int().min(10).max(10000),
    timezone: timezoneSchema,
    active: z.boolean().default(true),
    requireWebAuthn: z.boolean().default(true),
    requireGeofence: z.boolean().default(true),
    requireOfficeNetwork: z.boolean().default(true),
    requireApprovedDevice: z.boolean().default(true),
    maximumGpsAccuracyMeters: z.number().int().min(1).max(1000).default(50),
    weekendDays: z
      .array(z.number().int().min(0).max(6))
      .max(7)
      .refine((days) => new Set(days).size === days.length)
      .default([0, 6]),
  })
  .strict();
export const networkSchema = z
  .object({
    officeId: idSchema,
    publicIpOrCidr: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .refine((value) => {
        try {
          if (value.includes("/")) ipaddr.parseCIDR(value);
          else ipaddr.parse(value);
          return true;
        } catch {
          return false;
        }
      }, "Enter a valid IPv4/IPv6 address or CIDR."),
    description: z.string().trim().max(300).nullable().optional(),
    active: z.boolean().default(true),
  })
  .strict();
const clockTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:mm time.");
export const shiftSchema = z
  .object({
    name: label,
    startTime: clockTime,
    endTime: clockTime,
    graceMinutes: z.number().int().min(0).max(180).default(15),
    halfDayThreshold: z.number().int().min(1).max(1440).default(240),
    timezone: timezoneSchema,
    active: z.boolean().default(true),
  })
  .strict()
  .refine(
    (shift) => shift.startTime !== shift.endTime,
    "Shift start and end must be different.",
  );
export const assignmentSchema = z
  .object({
    employeeId: idSchema,
    shiftId: idSchema,
    startDate: dateSchema,
    endDate: dateSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (value) => !value.endDate || value.endDate >= value.startDate,
    "End date must be on or after start date.",
  );
export const holidaySchema = z
  .object({
    name: label,
    date: dateSchema,
    officeId: idSchema.nullable().optional(),
  })
  .strict();
export const driveCostSchema = z
  .object({
    date: dateSchema,
    destinationFrom: label,
    destinationTo: label,
    isRoundTrip: z.boolean().default(false),
    kilometers: z
      .number()
      .finite()
      .positive()
      .max(100000)
      .refine((value) => {
        const [coefficient, exponentText] = value
          .toString()
          .toLowerCase()
          .split("e");
        const fractionLength = coefficient.split(".")[1]?.length ?? 0;
        const exponent = exponentText ? Number(exponentText) : 0;
        return Math.max(0, fractionLength - exponent) <= 2;
      }, "Kilometers can have at most two decimal places."),
    rateType: z.enum(["IN_TIME", "OVER_TIME"]),
    paymentStatus: z.enum(["UNPAID", "PAID"]).optional(),
  })
  .strict();
export const driveCostPaymentStatusSchema = z
  .object({ paymentStatus: z.enum(["UNPAID", "PAID"]) })
  .strict();
export const driveCostUpdateSchema = driveCostSchema.or(
  driveCostPaymentStatusSchema,
);
export const leaveSchema = z
  .object({
    startDate: dateSchema,
    endDate: dateSchema,
    reason: z.string().trim().min(5).max(1000),
  })
  .strict()
  .refine(
    (value) => value.endDate >= value.startDate,
    "End date must be on or after start date.",
  )
  .refine(
    (value) =>
      (Date.parse(value.endDate) - Date.parse(value.startDate)) / 86400000 <=
      365,
    "A leave request cannot exceed one year.",
  );
export const leaveReviewSchema = z
  .object({
    status: z.enum(["APPROVED", "REJECTED"]),
    reviewNote: z.string().trim().max(1000).optional(),
  })
  .strict();
export const deviceUpdateSchema = z.union([
  z.object({ approved: z.boolean() }).strict(),
  z.object({ revoked: z.literal(true) }).strict(),
]);
export const userSchema = z
  .object({
    name: label,
    email: z.email().trim().toLowerCase().max(254),
    role: z.enum(["ADMIN", "SUPER_ADMIN"]),
    status: statusSchema.default("ACTIVE"),
  })
  .strict();
export const userUpdateSchema = z
  .object({
    name: label.optional(),
    role: z
      .enum(["EMPLOYEE", "MANAGE_DRIVER", "ADMIN", "SUPER_ADMIN"])
      .optional(),
    status: statusSchema.optional(),
  })
  .strict();
export const correctionSchema = z
  .object({
    checkInAt: z.iso.datetime({ offset: true }).nullable().optional(),
    checkOutAt: z.iso.datetime({ offset: true }).nullable().optional(),
    status: attendanceStatusSchema.optional(),
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();
export const newCorrectionSchema = correctionSchema.extend({
  employeeId: idSchema,
  attendanceDate: dateSchema,
});
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
});
export const driveCostFilterSchema = paginationSchema
  .extend({
    from: dateSchema.optional(),
    to: dateSchema.optional(),
  })
  .refine(
    (value) => !value.from || !value.to || value.to >= value.from,
    "End date must be on or after start date.",
  );
export const reportFilterSchema = z
  .object({
    employeeId: idSchema.optional(),
    departmentId: idSchema.optional(),
    officeId: idSchema.optional(),
    shiftId: idSchema.optional(),
    status: attendanceStatusSchema.optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    format: z.enum(["json", "pdf"]).default("json"),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine(
    (value) => !value.from || !value.to || value.to >= value.from,
    "End date must be on or after start date.",
  );

export function utcDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}
