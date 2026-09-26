import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { authorizeRole } from "@/modules/auth/authorization";
import { writeAudit } from "@/modules/audit/service";
import type { Actor } from "@/modules/management/permissions";
import {
  idSchema,
  leaveReviewSchema,
  paginationSchema,
} from "@/modules/management/validation";
import { approvalMatchesAttendance } from "./outcome";

export const lateApprovalReviewSchema = leaveReviewSchema;
export const lateApprovalFilterSchema = paginationSchema
  .pick({ page: true, pageSize: true })
  .extend({
    status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
  })
  .strict();

// Keep attendance verification evidence out of the review API.
const reviewSelect = {
  id: true,
  attendanceId: true,
  status: true,
  checkInAt: true,
  scheduledStartAt: true,
  lateMinutes: true,
  reason: true,
  requestedAt: true,
  reviewedAt: true,
  reviewNote: true,
  reviewedBy: { select: { id: true, name: true, email: true } },
  attendance: {
    select: {
      id: true,
      attendanceDate: true,
      checkInAt: true,
      lateMinutes: true,
      employee: {
        select: {
          id: true,
          employeeCode: true,
          user: { select: { id: true, name: true, email: true } },
        },
      },
      shift: { select: { timezone: true } },
    },
  },
} satisfies Prisma.LateApprovalRequestSelect;

export async function listLateApprovals(
  actor: Actor,
  input: z.input<typeof lateApprovalFilterSchema>,
) {
  authorizeRole(actor.role, "ADMIN");
  const { page, pageSize, status } = lateApprovalFilterSchema.parse(input);
  const where = status ? { status } : {};
  const [items, total] = await db.$transaction(
    [
      db.lateApprovalRequest.findMany({
        where,
        select: reviewSelect,
        orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.lateApprovalRequest.count({ where }),
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  return { items, total, page, pageSize };
}

export async function reviewLateApproval(
  actor: Actor,
  requestId: string,
  input: z.infer<typeof lateApprovalReviewSchema>,
) {
  authorizeRole(actor.role, "ADMIN");
  const id = idSchema.parse(requestId);
  const decision = lateApprovalReviewSchema.parse(input);
  return db.$transaction(
    async (tx) => {
      // Hold access stable for the transaction, and reject stale role DTOs.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actor.id} FOR SHARE`;
      const reviewer = await tx.user.findUnique({
        where: { id: actor.id },
        select: { role: true, status: true },
      });
      if (!reviewer || reviewer.status !== "ACTIVE")
        throw new DomainError(
          "FORBIDDEN",
          "An active administrator account is required.",
          403,
        );
      authorizeRole(reviewer.role, "ADMIN");
      const previous = await tx.lateApprovalRequest.findUnique({
        where: { id },
        select: reviewSelect,
      });
      if (!previous)
        throw new DomainError(
          "NOT_FOUND",
          "Late approval request not found.",
          404,
        );
      if (!previous.attendance.employee)
        throw new DomainError(
          "EMPLOYEE_DELETED",
          "This employee was deleted. Their late request is retained as history and cannot be reviewed.",
          409,
        );
      if (previous.attendance.employee.user.id === actor.id)
        throw new DomainError(
          "SELF_APPROVAL",
          "Another administrator must review your late request.",
          403,
        );
      if (previous.status !== "PENDING")
        throw new DomainError(
          "LATE_APPROVAL_ALREADY_REVIEWED",
          "This late request has already been reviewed. Refresh the list.",
          409,
        );
      // Corrections must not make an old request authorize different arrival facts.
      // Rejection remains available so a stale pending request can be finalized.
      if (
        decision.status === "APPROVED" &&
        !approvalMatchesAttendance(previous.attendance, previous)
      )
        throw new DomainError(
          "ATTENDANCE_CHANGED",
          "Attendance changed after this request. This request can no longer be approved.",
          409,
        );
      const changed = await tx.lateApprovalRequest.updateMany({
        where: { id, status: "PENDING" },
        data: { ...decision, reviewedById: actor.id, reviewedAt: new Date() },
      });
      if (changed.count !== 1)
        throw new DomainError(
          "LATE_APPROVAL_ALREADY_REVIEWED",
          "This late request has already been reviewed. Refresh the list.",
          409,
        );
      const result = await tx.lateApprovalRequest.findUniqueOrThrow({
        where: { id },
        select: reviewSelect,
      });
      await writeAudit(
        actor.id,
        `LATE_APPROVAL_${decision.status}`,
        "LateApprovalRequest",
        id,
        previous,
        result,
        tx,
      );
      await tx.attendanceEvent.create({
        data: {
          attendanceId: previous.attendanceId,
          employeeId: previous.attendance.employee.id,
          type: `LATE_APPROVAL_${decision.status}`,
          metadata: { actorId: actor.id, requestId: id },
        },
      });
      return result;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 15_000,
    },
  );
}
