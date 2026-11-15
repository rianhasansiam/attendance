import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit/service";
import { assertSuperAdmin, type Actor } from "@/modules/management/permissions";
import {
  dateSchema,
  idSchema,
  paginationSchema,
  utcDate,
} from "@/modules/management/validation";
import { overtimeRequestMatchesAttendance } from "./outcome";

export const overtimeRequestFilterSchema = paginationSchema
  .pick({ page: true, pageSize: true })
  .extend({
    search: z.string().trim().max(160).optional(),
    status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    departmentId: idSchema.optional(),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: "End date must be on or after start date.",
  });

export const overtimeRequestReviewSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("APPROVED") }).strict(),
  z
    .object({
      status: z.literal("REJECTED"),
      rejectionReason: z.string().trim().max(1000).optional(),
    })
    .strict(),
]);

// Review DTOs contain attendance facts, never IP/GPS or credential evidence.
const reviewSelect = {
  id: true,
  attendanceId: true,
  status: true,
  checkInAt: true,
  scheduledEndAt: true,
  checkOutAt: true,
  requestedMinutes: true,
  reason: true,
  createdAt: true,
  updatedAt: true,
  reviewedAt: true,
  rejectionReason: true,
  reviewedBy: { select: { id: true, name: true, email: true } },
  attendance: {
    select: {
      id: true,
      attendanceDate: true,
      checkInAt: true,
      checkOutAt: true,
      scheduledEndAt: true,
      employee: {
        select: {
          id: true,
          employeeCode: true,
          user: { select: { name: true, email: true } },
          department: { select: { id: true, name: true } },
        },
      },
      shift: { select: { timezone: true } },
    },
  },
} satisfies Prisma.OvertimeRequestSelect;

type ReviewRecord = Prisma.OvertimeRequestGetPayload<{
  select: typeof reviewSelect;
}>;

function requestDTO(request: ReviewRecord) {
  return {
    ...request,
    matchesAttendance: overtimeRequestMatchesAttendance(
      request.attendance,
      request,
    ),
  };
}

async function assertCurrentSuperAdmin(
  actor: Actor,
  tx: Prisma.TransactionClient,
) {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actor.id} FOR SHARE`;
  const current = await tx.user.findUnique({
    where: { id: actor.id },
    select: { id: true, role: true, status: true },
  });
  if (!current || current.status !== "ACTIVE")
    throw new DomainError(
      "FORBIDDEN",
      "An active super administrator account is required.",
      403,
    );
  assertSuperAdmin(current);
}

export async function listOvertimeRequests(
  actor: Actor,
  input: z.input<typeof overtimeRequestFilterSchema>,
) {
  assertSuperAdmin(actor);
  const { page, pageSize, search, status, from, to, departmentId } =
    overtimeRequestFilterSchema.parse(input);
  const employee: Prisma.EmployeeWhereInput = {
    ...(departmentId ? { departmentId } : {}),
    ...(search
      ? {
          OR: [
            { employeeCode: { contains: search, mode: "insensitive" } },
            { user: { name: { contains: search, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const where: Prisma.OvertimeRequestWhereInput = {
    ...(status ? { status } : {}),
    attendance: {
      ...(from || to
        ? {
            attendanceDate: {
              ...(from ? { gte: utcDate(from) } : {}),
              ...(to ? { lte: utcDate(to) } : {}),
            },
          }
        : {}),
      ...(search || departmentId ? { employee: { is: employee } } : {}),
    },
  };
  return db.$transaction(
    async (tx) => {
      await assertCurrentSuperAdmin(actor, tx);
      const [items, total] = await Promise.all([
        tx.overtimeRequest.findMany({
          where,
          select: reviewSelect,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.overtimeRequest.count({ where }),
      ]);
      return { items: items.map(requestDTO), total, page, pageSize };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export async function reviewOvertimeRequest(
  actor: Actor,
  requestId: string,
  input: z.input<typeof overtimeRequestReviewSchema>,
) {
  assertSuperAdmin(actor);
  const id = idSchema.parse(requestId);
  const decision = overtimeRequestReviewSchema.parse(input);
  const target = await db.overtimeRequest.findUnique({
    where: { id },
    select: { attendance: { select: { employeeId: true } } },
  });
  if (!target)
    throw new DomainError("NOT_FOUND", "Overtime request not found.", 404);
  return db.$transaction(
    async (tx) => {
      // Use attendance's employee lock before identity locks, matching checkout,
      // corrections and employee deletion. Reread facts after acquiring it.
      if (target.attendance.employeeId)
        await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${target.attendance.employeeId} FOR UPDATE`;
      await assertCurrentSuperAdmin(actor, tx);
      const previous = await tx.overtimeRequest.findUnique({
        where: { id },
        select: reviewSelect,
      });
      if (!previous)
        throw new DomainError("NOT_FOUND", "Overtime request not found.", 404);
      if (!previous.attendance.employee)
        throw new DomainError(
          "EMPLOYEE_DELETED",
          "This employee was deleted. Their overtime request is retained as history and cannot be reviewed.",
          409,
        );
      if (previous.status !== "PENDING")
        throw new DomainError(
          "OVERTIME_ALREADY_REVIEWED",
          "This overtime request has already been reviewed. Refresh the list.",
          409,
        );
      if (
        decision.status === "APPROVED" &&
        !overtimeRequestMatchesAttendance(previous.attendance, previous)
      )
        throw new DomainError(
          "ATTENDANCE_CHANGED",
          "Attendance changed after this request. This request can no longer be approved.",
          409,
        );
      const changed = await tx.overtimeRequest.updateMany({
        where: { id, status: "PENDING" },
        data: {
          status: decision.status,
          reviewedById: actor.id,
          reviewedAt: new Date(),
          rejectionReason:
            decision.status === "REJECTED"
              ? decision.rejectionReason || null
              : null,
        },
      });
      if (changed.count !== 1)
        throw new DomainError(
          "OVERTIME_ALREADY_REVIEWED",
          "This overtime request has already been reviewed. Refresh the list.",
          409,
        );
      const result = await tx.overtimeRequest.findUniqueOrThrow({
        where: { id },
        select: reviewSelect,
      });
      await writeAudit(
        actor.id,
        `OVERTIME_${decision.status}`,
        "OvertimeRequest",
        id,
        previous,
        result,
        tx,
      );
      await tx.attendanceEvent.create({
        data: {
          attendanceId: previous.attendanceId,
          employeeId: previous.attendance.employee.id,
          type: `OVERTIME_${decision.status}`,
          metadata: { actorId: actor.id, requestId: id },
        },
      });
      return requestDTO(result);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 15_000,
    },
  );
}
