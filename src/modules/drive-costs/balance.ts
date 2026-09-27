import "server-only";
import { Prisma, type DriveCostBalanceAddition } from "@prisma/client";
import { db } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit/service";
import { authorizeRole } from "@/modules/auth/authorization";
import { assertSuperAdmin, type Actor } from "@/modules/management/permissions";
import { driveCostBalanceInputSchema } from "./balance-validation";

export async function getDriveCostBalance(actor: Actor) {
  authorizeRole(actor.role, "MANAGE_DRIVER");
  // One statement snapshot keeps deposits, paid costs and their difference
  // consistent during concurrent changes. SQL numeric preserves exact cents.
  const [totals] = await db.$queryRaw<
    { balance: string; totalAdded: string; totalPaid: string }[]
  >`
    SELECT (added.total - paid.total)::text AS "balance",
      added.total::text AS "totalAdded", paid.total::text AS "totalPaid"
    FROM (SELECT COALESCE(SUM("amount"), 0) AS total FROM "DriveCostBalanceAddition") added
    CROSS JOIN (SELECT COALESCE(SUM("totalCost"), 0) AS total FROM "DriveCost"
      WHERE "paymentStatus" = 'PAID') paid
  `;
  return {
    balance: new Prisma.Decimal(totals.balance).toFixed(2),
    totalAdded: new Prisma.Decimal(totals.totalAdded).toFixed(2),
    totalPaid: new Prisma.Decimal(totals.totalPaid).toFixed(2),
  };
}

function additionDTO(record: DriveCostBalanceAddition) {
  return {
    id: record.id,
    amount: record.amount.toFixed(2),
    note: record.note,
    createdAt: record.createdAt.toISOString(),
  };
}

export async function addDriveCostBalance(actor: Actor, raw: unknown) {
  assertSuperAdmin(actor);
  const input = driveCostBalanceInputSchema.parse(raw);
  const amount = new Prisma.Decimal(input.amount);
  const note = input.note || null;
  const replay = (record: DriveCostBalanceAddition) => {
    if (
      record.createdById !== actor.id ||
      !record.amount.equals(amount) ||
      record.note !== note
    )
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "This balance request was already used for a different addition.",
        409,
      );
    return additionDTO(record);
  };
  try {
    return await db.$transaction(async (tx) => {
      const previous = await tx.driveCostBalanceAddition.findUnique({
        where: { requestId: input.requestId },
      });
      if (previous) return replay(previous);
      const record = await tx.driveCostBalanceAddition.create({
        data: {
          requestId: input.requestId,
          amount,
          note,
          createdById: actor.id,
        },
      });
      await writeAudit(
        actor.id,
        "DRIVE_COST_BALANCE_ADDED",
        "DriveCostBalanceAddition",
        record.id,
        undefined,
        record,
        tx,
      );
      return additionDTO(record);
    });
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== "P2002"
    )
      throw error;
    // A simultaneous retry may have committed while this transaction waited.
    const previous = await db.driveCostBalanceAddition.findUnique({
      where: { requestId: input.requestId },
    });
    if (!previous) throw error;
    return replay(previous);
  }
}
