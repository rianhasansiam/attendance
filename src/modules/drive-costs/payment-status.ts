import { db } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit/service";
import { assertSuperAdmin, type Actor } from "@/modules/management/permissions";
import { driveCostPaymentStatusSchema } from "@/modules/management/validation";

export async function updateDriveCostPaymentStatus(
  actor: Actor,
  id: string,
  raw: unknown,
) {
  assertSuperAdmin(actor);
  const data = driveCostPaymentStatusSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const previous = await tx.driveCost.findUnique({ where: { id } });
    if (!previous)
      throw new DomainError(
        "NOT_FOUND",
        "The requested drive cost was not found.",
        404,
      );
    const result = await tx.driveCost.update({ where: { id }, data });
    await writeAudit(
      actor.id,
      "DRIVE_COST_UPDATED",
      "DriveCost",
      id,
      previous,
      result,
      tx,
    );
    return result;
  });
}
