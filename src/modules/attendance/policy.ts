import { z } from "zod";

export const attendancePolicySchema = z.object({
  requireWebAuthn: z.boolean().default(true),
  requireGeofence: z.boolean().default(true),
  requireOfficeNetwork: z.boolean().default(true),
  requireApprovedDevice: z.boolean().default(true),
  maximumGpsAccuracyMeters: z.number().positive().max(1000).default(50),
});
export type AttendancePolicy = z.infer<typeof attendancePolicySchema>;
export function resolveAttendancePolicy(policy: unknown): AttendancePolicy {
  // Invalid persisted configuration fails closed; missing configuration uses strict defaults.
  return attendancePolicySchema.parse(policy ?? {});
}
