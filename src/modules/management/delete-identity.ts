import "server-only";
import type { Prisma } from "@prisma/client";
import { DomainError } from "@/lib/errors";
import { auditSnapshot } from "@/modules/audit/service";
import type { Actor } from "./permissions";

/** Called only after the caller locks and authorizes both identities.
 * All redaction, reference cleanup and account deletion share its transaction.
 */
export async function deleteIdentity(
  tx: Prisma.TransactionClient,
  actor: Actor,
  userId: string,
  employeeId: string | undefined,
  snapshot: unknown,
): Promise<Prisma.InputJsonValue> {
  const [schema] = await tx.$queryRaw<{ ready: boolean; receipts: boolean }[]>`
    SELECT to_regprocedure('redact_deleted_identity(jsonb,boolean)') IS NOT NULL AS ready,
      to_regclass('"DailyExpenseTransactionDeletion"') IS NOT NULL AS receipts
  `;
  if (!schema?.ready)
    throw new DomainError(
      "SCHEMA_UPDATE_REQUIRED",
      "Account deletion requires the latest database update. Apply the deleted-user references migration and try again.",
      503,
    );

  await tx.$queryRaw`
    SELECT set_config('app.user_deletion_actor_id', ${actor.id}, true),
      set_config('app.deleted_user_id', ${userId}, true),
      set_config('app.deleted_employee_id', ${employeeId ?? ""}, true)
  `;
  // The database permits only these exact, authorized identity changes to
  // otherwise immutable history. Financial facts and event details stay intact.
  await tx.$executeRaw`
    UPDATE "AuditLog" SET
      "actorId" = CASE WHEN "actorId" = ${userId} THEN NULL ELSE "actorId" END,
      "previousState" = redact_deleted_identity("previousState"),
      "newState" = redact_deleted_identity("newState")
    WHERE "actorId" = ${userId}
      OR "previousState" IS DISTINCT FROM redact_deleted_identity("previousState")
      OR "newState" IS DISTINCT FROM redact_deleted_identity("newState")
  `;
  await tx.$executeRaw`
    UPDATE "AttendanceEvent" SET
      "employeeId" = CASE WHEN "employeeId" = ${employeeId ?? ""} THEN NULL ELSE "employeeId" END,
      "metadata" = redact_deleted_identity("metadata")
    WHERE "employeeId" = ${employeeId ?? ""}
      OR "metadata" IS DISTINCT FROM redact_deleted_identity("metadata")
  `;
  await tx.leave.updateMany({
    where: { reviewedById: userId },
    data: { reviewedById: null },
  });
  if (schema.receipts)
    await tx.dailyExpenseTransactionDeletion.updateMany({
      where: { createdById: userId },
      data: { createdById: null },
    });

  const [redacted] = await tx.$queryRaw<{ snapshot: Prisma.InputJsonValue }[]>`
    SELECT redact_deleted_identity(${JSON.stringify(auditSnapshot(snapshot))}::jsonb) AS snapshot
  `;
  if (employeeId) {
    await tx.webAuthnCredential.deleteMany({ where: { employeeId } });
    // Retained attendance, shifts, leave and events lose only their identity FK.
    await tx.employee.delete({ where: { id: employeeId } });
  }
  // OAuth links, sessions and reset tokens cascade; history remains with NULL
  // identity references. User email/employee code can be reused for a new account.
  await tx.user.delete({ where: { id: userId } });
  return redacted.snapshot;
}
