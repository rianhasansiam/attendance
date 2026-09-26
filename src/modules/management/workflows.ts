import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit/service";
import { authorizeRole, isEmployeeRole } from "@/modules/auth/authorization";
import { publicUserSelect } from "@/modules/employees/service";
import { calculateCorrection } from "./corrections";
import {
  assertMayManageUser,
  assertSuperAdmin,
  type Actor,
} from "./permissions";
import {
  correctionSchema,
  deviceUpdateSchema,
  leaveReviewSchema,
  leaveSchema,
  newCorrectionSchema,
  policySchema,
  timezoneSchema,
  userSchema,
  userUpdateSchema,
  utcDate,
} from "./validation";

export const deviceSelect = {
  id: true,
  employeeId: true,
  name: true,
  deviceType: true,
  backedUp: true,
  approved: true,
  createdAt: true,
  revokedAt: true,
  employee: {
    select: {
      id: true,
      employeeCode: true,
      user: { select: publicUserSelect },
    },
  },
} satisfies Prisma.WebAuthnCredentialSelect;

export async function updateDevice(
  actor: Actor,
  id: string,
  input: z.infer<typeof deviceUpdateSchema>,
) {
  authorizeRole(actor.role, "ADMIN");
  return db.$transaction(async (tx) => {
    const previous = await tx.webAuthnCredential.findUnique({
      where: { id },
      select: deviceSelect,
    });
    if (!previous) throw new DomainError("NOT_FOUND", "Device not found.", 404);
    assertMayManageUser(actor, previous.employee.user);
    if (previous.revokedAt)
      throw new DomainError(
        "DEVICE_REVOKED",
        "A revoked device cannot be approved again.",
        409,
      );
    const revoking = "revoked" in input;
    const result = await tx.webAuthnCredential.update({
      where: { id },
      data: revoking
        ? { approved: false, revokedAt: new Date() }
        : { approved: input.approved },
      select: deviceSelect,
    });
    const type = revoking
      ? "DEVICE_REVOKED"
      : result.approved
        ? "DEVICE_APPROVED"
        : "DEVICE_APPROVAL_REMOVED";
    await tx.attendanceEvent.create({
      data: {
        employeeId: previous.employeeId,
        type,
        metadata: { actorId: actor.id, deviceId: id },
      },
    });
    await writeAudit(
      actor.id,
      type,
      "WebAuthnCredential",
      id,
      previous,
      result,
      tx,
    );
    return result;
  });
}

type EmployeeScope = { id: string; employee: { id: string } | null };
function ownEmployeeId(actor: EmployeeScope) {
  if (!actor.employee)
    throw new DomainError(
      "NO_EMPLOYEE",
      "An employee profile is required.",
      403,
    );
  return actor.employee.id;
}

export async function createLeave(
  actor: EmployeeScope,
  input: z.infer<typeof leaveSchema>,
) {
  const employeeId = ownEmployeeId(actor);
  const data = {
    employeeId,
    startDate: utcDate(input.startDate),
    endDate: utcDate(input.endDate),
    reason: input.reason,
  };
  return db.$transaction(
    async (tx) => {
      const employee = await tx.employee.findUnique({
        where: { id: employeeId, userId: actor.id },
        select: { id: true },
      });
      if (!employee)
        throw new DomainError(
          "NO_EMPLOYEE",
          "An employee profile is required.",
          403,
        );
      const overlap = await tx.leave.findFirst({
        where: {
          employeeId,
          status: { in: ["PENDING", "APPROVED"] },
          startDate: { lte: data.endDate },
          endDate: { gte: data.startDate },
        },
      });
      if (overlap)
        throw new DomainError(
          "OVERLAPPING_LEAVE",
          "An existing leave request overlaps these dates.",
          409,
        );
      return tx.leave.create({ data });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function reviewLeave(
  actor: Actor,
  id: string,
  input: z.infer<typeof leaveReviewSchema>,
) {
  authorizeRole(actor.role, "ADMIN");
  return db.$transaction(
    async (tx) => {
      const previous = await tx.leave.findUnique({
        where: { id },
        include: { employee: { select: { userId: true } } },
      });
      if (!previous)
        throw new DomainError("NOT_FOUND", "Leave request not found.", 404);
      if (previous.employee.userId === actor.id)
        throw new DomainError(
          "SELF_APPROVAL",
          "Another administrator must review your leave request.",
          403,
        );
      if (previous.status !== "PENDING")
        throw new DomainError(
          "LEAVE_ALREADY_REVIEWED",
          "This leave request has already been reviewed.",
          409,
        );
      if (
        input.status === "APPROVED" &&
        (await tx.attendance.findFirst({
          where: {
            employeeId: previous.employeeId,
            attendanceDate: { gte: previous.startDate, lte: previous.endDate },
            checkInAt: { not: null },
          },
        }))
      ) {
        throw new DomainError(
          "ATTENDANCE_CONFLICT",
          "This employee has attendance during the requested leave. Resolve attendance before approving leave.",
          409,
        );
      }
      const changed = await tx.leave.updateMany({
        where: { id, status: "PENDING" },
        data: { ...input, reviewedById: actor.id, reviewedAt: new Date() },
      });
      if (changed.count !== 1)
        throw new DomainError(
          "LEAVE_ALREADY_REVIEWED",
          "This leave request has already been reviewed.",
          409,
        );
      const result = await tx.leave.findUniqueOrThrow({ where: { id } });
      await writeAudit(
        actor.id,
        `LEAVE_${input.status}`,
        "Leave",
        id,
        previous,
        result,
        tx,
      );
      return result;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function cancelLeave(actor: EmployeeScope, id: string) {
  const employeeId = ownEmployeeId(actor);
  const changed = await db.leave.updateMany({
    where: {
      id,
      employeeId,
      employee: { userId: actor.id },
      status: "PENDING",
    },
    data: { status: "CANCELLED" },
  });
  if (changed.count !== 1)
    throw new DomainError(
      "LEAVE_NOT_CANCELLABLE",
      "Only your own pending leave requests can be cancelled.",
      409,
    );
  return { id, status: "CANCELLED" };
}

export async function createAdministrator(
  actor: Actor,
  input: z.infer<typeof userSchema>,
) {
  assertSuperAdmin(actor);
  return db.$transaction(async (tx) => {
    const result = await tx.user.create({
      data: input,
      select: publicUserSelect,
    });
    await writeAudit(
      actor.id,
      "ADMINISTRATOR_CREATED",
      "User",
      result.id,
      undefined,
      result,
      tx,
    );
    return result;
  });
}

export async function updateUser(
  actor: Actor,
  id: string,
  input: z.infer<typeof userUpdateSchema>,
) {
  assertSuperAdmin(actor);
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${id} FOR UPDATE`;
      const previous = await tx.user.findUnique({
        where: { id },
        select: { ...publicUserSelect, employee: { select: { id: true } } },
      });
      if (!previous) throw new DomainError("NOT_FOUND", "User not found.", 404);
      assertMayManageUser(actor, previous, input);
      if (input.role && isEmployeeRole(input.role) && !previous.employee)
        throw new DomainError(
          "EMPLOYEE_REQUIRED",
          "This user needs an employee profile before receiving an employee role.",
        );
      if (
        previous.role === "SUPER_ADMIN" &&
        ((input.role && input.role !== "SUPER_ADMIN") ||
          (input.status && input.status !== "ACTIVE"))
      ) {
        const remaining = await tx.user.count({
          where: { role: "SUPER_ADMIN", status: "ACTIVE", id: { not: id } },
        });
        if (remaining === 0)
          throw new DomainError(
            "LAST_SUPER_ADMIN",
            "At least one active super administrator is required.",
            409,
          );
      }
      const result = await tx.user.update({
        where: { id },
        data: input,
        select: publicUserSelect,
      });
      if (input.role || input.status)
        await tx.session.deleteMany({ where: { userId: id } });
      await writeAudit(
        actor.id,
        input.role ? "ROLE_CHANGED" : "USER_UPDATED",
        "User",
        id,
        previous,
        result,
        tx,
      );
      return result;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

const settingSchema = z.discriminatedUnion("key", [
  z
    .object({
      key: z.literal("organization"),
      value: z
        .object({
          name: z.string().trim().min(1).max(160),
          timezone: timezoneSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({ key: z.literal("attendance.defaultPolicy"), value: policySchema })
    .strict(),
]);

export async function saveSetting(actor: Actor, raw: unknown) {
  assertSuperAdmin(actor);
  const input = settingSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const previous = await tx.systemSetting.findUnique({
      where: { key: input.key },
    });
    const result = await tx.systemSetting.upsert({
      where: { key: input.key },
      create: input,
      update: { value: input.value },
    });
    await writeAudit(
      actor.id,
      "GLOBAL_SETTING_UPDATED",
      "SystemSetting",
      input.key,
      previous ?? undefined,
      result,
      tx,
    );
    return result;
  });
}

async function assertCurrentCorrectionAccess(
  actor: Actor,
  tx: Prisma.TransactionClient,
) {
  const currentActor = await tx.user.findUnique({
    where: { id: actor.id },
    select: { id: true, role: true, status: true },
  });
  if (!currentActor || currentActor.status !== "ACTIVE")
    throw new DomainError(
      "FORBIDDEN",
      "An active super administrator account is required to correct attendance.",
      403,
    );
  assertSuperAdmin(currentActor);
}

export async function correctAttendance(
  actor: Actor,
  id: string,
  input: z.infer<typeof correctionSchema>,
) {
  assertSuperAdmin(actor);
  return db.$transaction(
    async (tx) => {
      await assertCurrentCorrectionAccess(actor, tx);
      const previous = await tx.attendance.findUnique({
        where: { id },
        include: { shift: true },
      });
      if (!previous)
        throw new DomainError("NOT_FOUND", "Attendance record not found.", 404);
      const result = await tx.attendance.update({
        where: { id },
        data: calculateCorrection(previous, input),
        include: { lateApproval: true },
      });
      await tx.attendanceEvent.create({
        data: {
          employeeId: previous.employeeId,
          attendanceId: id,
          type: "ADMIN_CORRECTION",
          reason: input.reason,
          metadata: { actorId: actor.id },
        },
      });
      await writeAudit(
        actor.id,
        "ATTENDANCE_CORRECTED",
        "Attendance",
        id,
        previous,
        { ...result, reason: input.reason },
        tx,
      );
      return result;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function createAttendanceCorrection(
  actor: Actor,
  input: z.infer<typeof newCorrectionSchema>,
) {
  assertSuperAdmin(actor);
  const attendanceDate = utcDate(input.attendanceDate);
  return db.$transaction(
    async (tx) => {
      await assertCurrentCorrectionAccess(actor, tx);
      const employee = await tx.employee.findUnique({
        where: { id: input.employeeId },
      });
      if (!employee)
        throw new DomainError("NOT_FOUND", "Employee not found.", 404);
      const assignment = await tx.employeeShift.findFirst({
        where: {
          employeeId: employee.id,
          startDate: { lte: attendanceDate },
          OR: [{ endDate: null }, { endDate: { gte: attendanceDate } }],
        },
        include: { shift: true },
      });
      if (!assignment)
        throw new DomainError(
          "NO_ACTIVE_SHIFT",
          "Assign a shift for this attendance date before correcting it.",
        );
      const data = calculateCorrection(
        {
          checkInAt: null,
          checkOutAt: null,
          attendanceDate,
          shift: assignment.shift,
        },
        input,
      );
      const result = await tx.attendance.create({
        data: {
          employeeId: employee.id,
          officeId: employee.officeId,
          shiftId: assignment.shiftId,
          attendanceDate,
          ...data,
        },
      });
      await tx.attendanceEvent.create({
        data: {
          employeeId: employee.id,
          attendanceId: result.id,
          type: "ADMIN_CORRECTION",
          reason: input.reason,
          metadata: { actorId: actor.id },
        },
      });
      await writeAudit(
        actor.id,
        "ATTENDANCE_CORRECTED",
        "Attendance",
        result.id,
        undefined,
        { ...result, reason: input.reason },
        tx,
      );
      return result;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
