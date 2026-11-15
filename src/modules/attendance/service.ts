import { hasLoginIdentity } from "@/modules/auth/account-policy";
import { attendanceDisplaySelect } from "./queries";
import { attendanceOutcome, type AttendanceOutcomeInput } from "./outcome";
import { Prisma, type Shift, type EmployeeShift } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { DomainError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit/service";
import { measureServerTiming, type ServerTiming } from "@/lib/server-timing";
import { locationSchema, verifyGeofence } from "@/modules/geofence/service";
import {
  extractClientIp,
  verifyOfficeNetwork,
} from "@/modules/network/service";
import {
  calculateCheckIn,
  calculateCheckOut,
  getShiftWindow,
  shiftDate,
} from "@/modules/shifts/calculations";
import {
  consumeChallenge,
  deviceSelect,
  verifyAttendanceAssertion,
  type EmployeeActor,
} from "@/modules/webauthn/service";
import { authenticationResponseSchema } from "@/modules/webauthn/validation";
import { resolveAttendancePolicy } from "./policy";
import {
  calculateEligibleOvertime,
  MINIMUM_ELIGIBLE_OVERTIME_MINUTES,
} from "./overtime-policy";

export const attendanceEvidenceSchema = z
  .object({
    challengeId: z.string().min(1).max(100).optional(),
    response: authenticationResponseSchema.optional(),
    location: locationSchema.optional(),
  })
  .strict();
export const checkoutEvidenceSchema = attendanceEvidenceSchema.extend({
  attendanceId: z.string().trim().min(1).max(100),
  overtimeReason: z
    .string()
    .trim()
    .min(10)
    .max(1000)
    .refine((value) => Array.from(value).length >= 10, {
      message: "Provide an overtime reason of at least 10 characters.",
    })
    .optional(),
});
export type AttendanceEvidence =
  | z.infer<typeof attendanceEvidenceSchema>
  | z.infer<typeof checkoutEvidenceSchema>;
export type AttendanceAction = "CHECK_IN" | "CHECK_OUT";

export const lateReasonSchema = z
  .object({
    attendanceId: z.string().trim().min(1).max(100),
    reason: z.string().trim().min(1).max(1000),
    requestApproval: z.boolean().optional(),
  })
  .strict();

export async function saveLateReason(
  actor: EmployeeActor,
  input: z.infer<typeof lateReasonSchema>,
) {
  const { attendanceId, reason, requestApproval } =
    lateReasonSchema.parse(input);
  return db.$transaction(
    async (tx) => {
      // Serialize with check-in and checkout so the reason belongs to the same
      // authorized attendance record throughout the update and audit event.
      await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${actor.employee.id} FOR UPDATE`;
      const employee = await tx.employee.findUnique({
        where: { id: actor.employee.id },
        select: {
          id: true,
          user: {
            select: {
              id: true,
              status: true,
              googleAccountId: true,
              passwordHash: true,
            },
          },
        },
      });
      if (employee?.user.status !== "ACTIVE")
        throw new DomainError(
          "USER_INACTIVE",
          "Your account is not active.",
          403,
        );
      const session = await tx.session.findFirst({
        where: {
          id: actor.sessionId,
          userId: actor.id,
          expires: { gt: new Date() },
        },
        select: { id: true },
      });
      if (
        !session ||
        employee.user.id !== actor.id ||
        !hasLoginIdentity(employee.user) ||
        employee.user.googleAccountId !== actor.googleAccountId
      )
        throw new DomainError(
          "USER_NOT_AUTHORIZED",
          "Your authorization has changed. Sign in again.",
          403,
        );
      const record = await tx.attendance.findFirst({
        where: { id: attendanceId, employeeId: employee.id },
        select: attendanceDisplaySelect,
      });
      if (!record)
        throw new DomainError(
          "ATTENDANCE_NOT_FOUND",
          "Attendance was not found.",
          404,
        );
      if (!record.checkInAt || record.lateMinutes <= 0)
        throw new DomainError(
          "ATTENDANCE_NOT_LATE",
          "A late reason is only needed for a late check-in.",
          409,
        );
      if (record.lateReason !== null) {
        // Retrying a successful request must not create another audit event.
        if (record.lateReason !== reason)
          throw new DomainError(
            "LATE_REASON_ALREADY_SUBMITTED",
            "A reason has already been submitted for this attendance.",
            409,
          );
      }
      const createApproval = requestApproval && !record.lateApproval;
      if (record.lateReason !== null && !createApproval)
        return sanitizeAttendance(record);
      const updated = await tx.attendance.update({
        where: { id: record.id },
        data: {
          lateReason: reason,
          ...(createApproval
            ? {
                lateApproval: {
                  create: {
                    checkInAt: record.checkInAt,
                    scheduledStartAt: record.scheduledStartAt,
                    lateMinutes: record.lateMinutes,
                    reason,
                  },
                },
              }
            : {}),
        },
        select: attendanceDisplaySelect,
      });
      if (record.lateReason === null)
        await tx.attendanceEvent.create({
          data: {
            employeeId: employee.id,
            attendanceId: record.id,
            type: "LATE_REASON_SUBMITTED",
          },
        });
      if (createApproval)
        await tx.attendanceEvent.create({
          data: {
            employeeId: employee.id,
            attendanceId: record.id,
            type: "LATE_APPROVAL_REQUESTED",
            metadata: { requestId: updated.lateApproval!.id },
          },
        });
      return sanitizeAttendance(updated);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 15_000,
    },
  );
}

export function assertAttendanceState(
  action: AttendanceAction,
  existing: { checkInAt: Date | null; checkOutAt: Date | null } | null,
) {
  if (action === "CHECK_IN" && existing?.checkInAt)
    throw new DomainError(
      "ALREADY_CHECKED_IN",
      "You have already checked in for this shift.",
      409,
    );
  if (action === "CHECK_OUT" && (!existing?.checkInAt || existing.checkOutAt))
    throw new DomainError(
      "NOT_CHECKED_IN",
      "There is no open check-in to check out from.",
      409,
    );
}

export function resolveShiftAssignment(
  assignments: (EmployeeShift & { shift: Shift })[],
  now: Date,
) {
  return assignments.find((assignment) => {
    if (!assignment.shift.active) return false;
    const day = getShiftWindow(now, assignment.shift).attendanceDate;
    return (
      assignment.startDate <= day &&
      (!assignment.endDate || assignment.endDate >= day)
    );
  });
}

/** An informational preview. The final locked write uses its own server time. */
export async function previewCheckout(actor: EmployeeActor) {
  const attendance = await db.attendance.findFirst({
    where: {
      employeeId: actor.employee.id,
      checkInAt: { not: null },
      checkOutAt: null,
    },
    select: {
      id: true,
      attendanceDate: true,
      checkInAt: true,
      checkOutAt: true,
      scheduledEndAt: true,
      shift: true,
    },
  });
  assertAttendanceState("CHECK_OUT", attendance);
  const serverTime = new Date();
  const scheduledEndAt =
    attendance!.scheduledEndAt ??
    getShiftWindow(
      serverTime,
      attendance!.shift,
      attendance!.attendanceDate.toISOString().slice(0, 10),
    ).endsAt;
  const extraMinutes = calculateEligibleOvertime(
    attendance!.checkInAt!,
    serverTime,
    scheduledEndAt,
  );
  if (extraMinutes === null)
    throw new DomainError(
      "NO_ACTIVE_SHIFT",
      "A valid duty schedule is required before checking out.",
      409,
    );
  return {
    attendanceId: attendance!.id,
    employeeName: actor.name || actor.email,
    scheduledEndAt,
    serverTime,
    extraMinutes,
    eligible: extraMinutes >= MINIMUM_ELIGIBLE_OVERTIME_MINUTES,
    timezone: attendance!.shift.timezone,
  };
}

export async function recordAttendance(
  actor: EmployeeActor,
  action: AttendanceAction,
  evidence: AttendanceEvidence,
  headers: Headers,
  timing?: ServerTiming,
) {
  const ip = extractClientIp(headers, getEnv());
  try {
    const checkout =
      action === "CHECK_OUT" ? checkoutEvidenceSchema.parse(evidence) : null;
    evidence = checkout ?? attendanceEvidenceSchema.parse(evidence);
    const initialOffice = await measureServerTiming(
      timing,
      "initial_policy",
      () =>
        db.office.findUniqueOrThrow({
          where: { id: actor.employee.officeId },
        }),
    );
    const initialPolicy = resolveAttendancePolicy(initialOffice);
    let challenge: string | undefined;
    if (initialPolicy.requireWebAuthn) {
      if (!evidence.challengeId || !evidence.response)
        throw new DomainError(
          "WEBAUTHN_REQUIRED",
          "Confirm attendance with your registered passkey.",
        );
      const challengeId = evidence.challengeId;
      challenge = await measureServerTiming(timing, "challenge", () =>
        consumeChallenge(actor, action, challengeId),
      );
    }
    // Acquisition includes pool wait and BEGIN. Finish includes commit/rollback
    // and driver overhead; Prisma does not expose those components separately.
    const finishAcquisition = timing?.start("tx_acquire");
    let finishTransaction: (() => void) | undefined;
    try {
      return await measureServerTiming(timing, "transaction", () =>
        db.$transaction(
          async (tx) => {
            finishAcquisition?.();
            try {
              // Every attendance mutation for an employee serializes on this row. The
              // unique day key and partial open-record index provide final DB protection.
              await measureServerTiming(
                timing,
                "employee_lock",
                () =>
                  tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${actor.employee.id} FOR UPDATE`,
              );
              const now = new Date();
              const employee = await measureServerTiming(
                timing,
                "authoritative_reads",
                () =>
                  tx.employee.findUniqueOrThrow({
                    where: { id: actor.employee.id },
                    include: {
                      user: true,
                      office: { include: { networks: true } },
                      shifts: {
                        include: { shift: true },
                        orderBy: { startDate: "desc" },
                      },
                    },
                  }),
              );
              if (employee.user.status !== "ACTIVE")
                throw new DomainError(
                  "USER_INACTIVE",
                  "Your account is not active.",
                  403,
                );
              const session = await measureServerTiming(
                timing,
                "authoritative_reads",
                () =>
                  tx.session.findFirst({
                    where: {
                      id: actor.sessionId,
                      userId: actor.id,
                      expires: { gt: now },
                    },
                    select: { id: true },
                  }),
              );
              if (
                !session ||
                !hasLoginIdentity(employee.user) ||
                employee.user.googleAccountId !== actor.googleAccountId
              ) {
                throw new DomainError(
                  "USER_NOT_AUTHORIZED",
                  "Your authorization has changed. Sign in again.",
                  403,
                );
              }
              if (!employee.office.active)
                throw new DomainError(
                  "OFFICE_INACTIVE",
                  "Your assigned office is inactive.",
                  403,
                );
              const policy = resolveAttendancePolicy(employee.office);
              const openAttendance = await measureServerTiming(
                timing,
                "authoritative_reads",
                () =>
                  tx.attendance.findFirst({
                    where: {
                      employeeId: employee.id,
                      checkInAt: { not: null },
                      checkOutAt: null,
                    },
                    include: { shift: true, overtimeRequest: true },
                  }),
              );
              if (action === "CHECK_IN" && openAttendance)
                throw new DomainError(
                  "ALREADY_CHECKED_IN",
                  "Check out of your current shift before checking in again.",
                  409,
                );
              if (action === "CHECK_OUT")
                assertAttendanceState(action, openAttendance);
              if (checkout && checkout.attendanceId !== openAttendance!.id)
                throw new DomainError(
                  "ATTENDANCE_CHANGED",
                  "Your active attendance changed. Refresh and try checkout again.",
                  409,
                );
              const assignment = resolveShiftAssignment(employee.shifts, now);
              const shift =
                action === "CHECK_OUT"
                  ? openAttendance!.shift
                  : assignment?.shift;
              if (!shift)
                throw new DomainError(
                  "NO_ACTIVE_SHIFT",
                  "No active shift is assigned for this date.",
                );
              const window = getShiftWindow(
                now,
                shift,
                action === "CHECK_OUT"
                  ? openAttendance!.attendanceDate.toISOString().slice(0, 10)
                  : undefined,
              );
              const existing =
                action === "CHECK_OUT"
                  ? openAttendance
                  : await measureServerTiming(
                      timing,
                      "authoritative_reads",
                      () =>
                        tx.attendance.findUnique({
                          where: {
                            employeeId_attendanceDate: {
                              employeeId: employee.id,
                              attendanceDate: window.attendanceDate,
                            },
                          },
                        }),
                    );
              assertAttendanceState(action, existing);
              const requestedMinutes = checkout
                ? calculateEligibleOvertime(
                    existing!.checkInAt!,
                    now,
                    existing!.scheduledEndAt ?? window.endsAt,
                  )
                : null;
              if (checkout && requestedMinutes === null)
                throw new DomainError(
                  "NO_ACTIVE_SHIFT",
                  "A valid duty schedule is required before checking out.",
                  409,
                );
              const requestOvertime =
                requestedMinutes !== null &&
                requestedMinutes >= MINIMUM_ELIGIBLE_OVERTIME_MINUTES;
              if (requestOvertime && !checkout?.overtimeReason)
                throw new DomainError(
                  "OVERTIME_REASON_REQUIRED",
                  "Provide an overtime reason before checking out.",
                  409,
                );
              if (requestOvertime && openAttendance?.overtimeRequest)
                throw new DomainError(
                  "OVERTIME_ALREADY_REQUESTED",
                  "This attendance already has an overtime request. Ask a super administrator to complete the attendance correction.",
                  409,
                );
              const { credentialId, distance } = await measureServerTiming(
                timing,
                "verification",
                async () => {
                  let credentialId: string | null = null;
                  if (policy.requireWebAuthn) {
                    if (!challenge || !evidence.response)
                      throw new DomainError(
                        "WEBAUTHN_REQUIRED",
                        "Office security policy changed. Please try attendance again.",
                      );
                    credentialId = await verifyAttendanceAssertion(
                      tx,
                      actor,
                      evidence.response,
                      challenge,
                      policy.requireApprovedDevice,
                    );
                  }
                  const distance = policy.requireGeofence
                    ? verifyGeofence(
                        evidence.location,
                        employee.office,
                        policy.maximumGpsAccuracyMeters,
                      )
                    : null;
                  if (policy.requireOfficeNetwork)
                    verifyOfficeNetwork(ip, employee.office.networks);
                  return { credentialId, distance };
                },
              );
              // Persist coordinates only when the configured policy actually uses them.
              const location = policy.requireGeofence
                ? evidence.location
                : undefined;
              const record = await measureServerTiming(
                timing,
                "db_write",
                async () => {
                  let record;
                  if (action === "CHECK_IN") {
                    const data = {
                      officeId: employee.officeId,
                      shiftId: shift.id,
                      scheduledStartAt: window.startsAt,
                      scheduledEndAt: window.endsAt,
                      overtimeMinutes: 0,
                      checkInAt: now,
                      checkInLatitude: location?.latitude,
                      checkInLongitude: location?.longitude,
                      checkInAccuracy: location?.accuracy,
                      checkInDistanceMeters: distance,
                      checkInIp: ip,
                      checkInCredentialId: credentialId,
                      ...calculateCheckIn(
                        now,
                        window.startsAt,
                        shift.graceMinutes,
                      ),
                    };
                    record = existing
                      ? await tx.attendance.update({
                          where: { id: existing.id },
                          data,
                          select: attendanceDisplaySelect,
                        })
                      : await tx.attendance.create({
                          data: {
                            employeeId: employee.id,
                            attendanceDate: window.attendanceDate,
                            ...data,
                          },
                          select: attendanceDisplaySelect,
                        });
                  } else {
                    record = await tx.attendance.update({
                      where: { id: existing!.id },
                      data: {
                        checkOutAt: now,
                        // Legacy open rows have no snapshot; establish it once using
                        // that row's original business date and linked shift.
                        scheduledEndAt:
                          existing!.scheduledEndAt ?? window.endsAt,
                        scheduledStartAt:
                          existing!.scheduledStartAt ?? window.startsAt,
                        checkOutLatitude: location?.latitude,
                        checkOutLongitude: location?.longitude,
                        checkOutAccuracy: location?.accuracy,
                        checkOutDistanceMeters: distance,
                        checkOutIp: ip,
                        checkOutCredentialId: credentialId,
                        ...calculateCheckOut(
                          existing!.checkInAt!,
                          now,
                          shift.halfDayThreshold,
                          existing!.lateMinutes,
                          existing!.scheduledEndAt ?? window.endsAt,
                        ),
                        ...(requestOvertime
                          ? {
                              overtimeRequest: {
                                create: {
                                  checkInAt: existing!.checkInAt!,
                                  scheduledEndAt:
                                    existing!.scheduledEndAt ?? window.endsAt,
                                  checkOutAt: now,
                                  requestedMinutes: requestedMinutes!,
                                  reason: checkout!.overtimeReason!,
                                },
                              },
                            }
                          : {}),
                      },
                      select: attendanceDisplaySelect,
                    });
                  }
                  if (requestOvertime && record.overtimeRequest) {
                    await tx.attendanceEvent.create({
                      data: {
                        employeeId: employee.id,
                        attendanceId: record.id,
                        type: "OVERTIME_REQUESTED",
                        metadata: { requestId: record.overtimeRequest.id },
                      },
                    });
                    await writeAudit(
                      actor.id,
                      "OVERTIME_REQUESTED",
                      "OvertimeRequest",
                      record.overtimeRequest.id,
                      undefined,
                      record.overtimeRequest,
                      tx,
                    );
                  }
                  await tx.attendanceEvent.create({
                    data: {
                      employeeId: employee.id,
                      attendanceId: record.id,
                      type: `${action}_SUCCESS`,
                      metadata: { credentialId, distanceMeters: distance },
                    },
                  });
                  return record;
                },
              );
              return sanitizeAttendance(record);
            } finally {
              finishTransaction = timing?.start("tx_finish");
            }
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 15_000,
          },
        ),
      );
    } finally {
      finishAcquisition?.();
      finishTransaction?.();
    }
  } catch (error) {
    let domainError = error;
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002")
        domainError = new DomainError(
          "ALREADY_CHECKED_IN",
          "Attendance has already been recorded. Refresh your dashboard.",
          409,
        );
      else if (error.code === "P2034")
        domainError = new DomainError(
          "ATTENDANCE_CONFLICT",
          "Attendance changed during verification. Refresh and try again.",
          409,
        );
    }
    await db.attendanceEvent.create({
      data: {
        employeeId: actor.employee.id,
        type: `${action}_REJECTED`,
        reason:
          domainError instanceof DomainError
            ? domainError.code
            : "INTERNAL_ERROR",
      },
    });
    throw domainError;
  }
}

export function sanitizeAttendance<
  T extends AttendanceOutcomeInput & {
    id: string;
    attendanceDate: Date;
    checkInAt: Date | null;
    checkOutAt: Date | null;
    status: string;
    lateMinutes: number;
    lateReason: string | null;
    workedMinutes: number;
    overtimeMinutes: number | null;
  },
>(record: T) {
  return {
    id: record.id,
    attendanceDate: record.attendanceDate,
    checkInAt: record.checkInAt,
    checkOutAt: record.checkOutAt,
    lateMinutes: record.lateMinutes,
    lateReason: record.lateReason,
    workedMinutes: record.workedMinutes,
    ...attendanceOutcome(record),
  };
}

export async function employeeDashboard(
  actor: EmployeeActor,
  headers: Headers,
) {
  const employee = await db.employee.findUniqueOrThrow({
    where: { id: actor.employee.id },
    include: {
      user: { select: { name: true, email: true, image: true } },
      department: true,
      office: { include: { networks: true } },
      shifts: { include: { shift: true }, orderBy: { startDate: "desc" } },
    },
  });
  const now = new Date();
  const assignment = resolveShiftAssignment(employee.shifts, now);
  const day = assignment
    ? getShiftWindow(now, assignment.shift).attendanceDate
    : new Date(`${shiftDate(now, employee.office.timezone)}T00:00:00Z`);
  const [records, devices, holiday, leave, open] = await Promise.all([
    db.attendance.findMany({
      where: { employeeId: employee.id },
      orderBy: { attendanceDate: "desc" },
      take: 14,
      select: attendanceDisplaySelect,
    }),
    db.webAuthnCredential.findMany({
      // The dashboard only displays the approved-device count. Registration
      // caps non-revoked credentials at ten; revoked history is paginated separately.
      where: { employeeId: employee.id, approved: true, revokedAt: null },
      select: deviceSelect,
      orderBy: { createdAt: "desc" },
    }),
    db.holiday.findFirst({
      where: {
        date: day,
        OR: [{ officeId: employee.officeId }, { officeId: null }],
      },
    }),
    db.leave.findFirst({
      where: {
        employeeId: employee.id,
        status: "APPROVED",
        startDate: { lte: day },
        endDate: { gte: day },
      },
    }),
    db.attendance.findFirst({
      select: attendanceDisplaySelect,
      where: {
        employeeId: employee.id,
        checkInAt: { not: null },
        checkOutAt: null,
      },
    }),
  ]);
  const record =
    open ??
    records.find((record) => record.attendanceDate.getTime() === day.getTime());
  const policy = resolveAttendancePolicy(employee.office);
  const ip = extractClientIp(headers, getEnv());
  let networkVerified = !policy.requireOfficeNetwork;
  if (policy.requireOfficeNetwork) {
    try {
      verifyOfficeNetwork(ip, employee.office.networks);
      networkVerified = true;
    } catch {
      /* show a neutral actionable status */
    }
  }
  const fallbackStatus = leave
    ? "LEAVE"
    : holiday
      ? "HOLIDAY"
      : employee.office.weekendDays.includes(day.getUTCDay())
        ? "WEEKEND"
        : "NOT_CHECKED_IN";
  return {
    employee: {
      id: employee.id,
      employeeCode: employee.employeeCode,
      user: employee.user,
      department: employee.department
        ? { id: employee.department.id, name: employee.department.name }
        : null,
      office: {
        id: employee.office.id,
        name: employee.office.name,
        address: employee.office.address,
        timezone: employee.office.timezone,
        policy,
      },
    },
    shift: assignment?.shift ?? null,
    today: record
      ? sanitizeAttendance(record)
      : {
          attendanceDate: day,
          checkInAt: null,
          checkOutAt: null,
          lateMinutes: 0,
          lateReason: null,
          workedMinutes: 0,
          ...attendanceOutcome({
            status: fallbackStatus,
            checkInAt: null,
            checkOutAt: null,
            lateMinutes: 0,
            overtimeMinutes: 0,
          }),
        },
    recent: records.map(sanitizeAttendance),
    devices,
    network: { verified: networkVerified },
    serverTime: now,
  };
}
