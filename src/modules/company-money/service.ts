import "server-only";
import { isDeepStrictEqual } from "node:util";
import {
  Prisma,
  type CompanyMoneyMutationOperation,
  type CompanyMoneyMutationReceipt,
  type Role,
  type UserStatus,
} from "@prisma/client";
import { db } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit/service";
import { authorizeRole } from "@/modules/auth/authorization";
import { assertSuperAdmin, type Actor } from "@/modules/management/permissions";
import { idSchema } from "@/modules/management/validation";
import {
  companyMoneyInputSchema,
  companyMoneyListSchema,
  companyMoneyUpdateSchema,
  companyMoneyDeleteSchema,
  type CompanyMoneyInput,
  type CompanyMoneyOverview,
  type CompanyMoneyTransactionRecord,
} from "./contracts";

const transactionInclude = {
  createdBy: { select: { name: true, email: true } },
} satisfies Prisma.CompanyMoneyTransactionInclude;
type TransactionWithActor = Prisma.CompanyMoneyTransactionGetPayload<{
  include: typeof transactionInclude;
}>;

function transactionDTO(
  record: TransactionWithActor,
): CompanyMoneyTransactionRecord {
  return {
    id: record.id,
    version: record.version,
    type: record.type,
    amount: record.amount.toFixed(2),
    date: record.date.toISOString().slice(0, 10),
    note: record.note,
    createdAt: record.createdAt.toISOString(),
    createdBy: record.createdBy,
  };
}

async function totals(client: Pick<Prisma.TransactionClient, "$queryRaw">) {
  const [record] = await client.$queryRaw<
    { balance: string; totalAdded: string; totalRemoved: string }[]
  >`
    SELECT
      COALESCE(SUM(CASE WHEN "type" = 'ADD' THEN "amount" ELSE -"amount" END), 0)::text AS "balance",
      COALESCE(SUM("amount") FILTER (WHERE "type" = 'ADD'), 0)::text AS "totalAdded",
      COALESCE(SUM("amount") FILTER (WHERE "type" = 'REMOVE'), 0)::text AS "totalRemoved"
    FROM "CompanyMoneyTransaction"
  `;
  return {
    balance: new Prisma.Decimal(record.balance).toFixed(2),
    totalAdded: new Prisma.Decimal(record.totalAdded).toFixed(2),
    totalRemoved: new Prisma.Decimal(record.totalRemoved).toFixed(2),
  };
}

export async function getCompanyMoneyOverview(
  actor: Actor,
  raw: unknown = {},
): Promise<CompanyMoneyOverview> {
  authorizeRole(actor.role, "ADMIN");
  const { page, pageSize } = companyMoneyListSchema.parse(raw);
  // History, count and totals use the same snapshot during concurrent changes.
  return db.$transaction(
    async (tx) => {
      const summary = await totals(tx);
      const total = await tx.companyMoneyTransaction.count();
      const items = await tx.companyMoneyTransaction.findMany({
        include: transactionInclude,
        orderBy: [{ date: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      });
      return {
        ...summary,
        items: items.map(transactionDTO),
        total,
        page,
        pageSize,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

async function writeTransaction<T>(
  actor: Actor,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return db.$transaction(
    async (tx) => {
      // A shared PostgreSQL lock serializes balance checks across app instances.
      // Keep READ COMMITTED so queries after waiting see the preceding commit.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(187463, 1)`;
      const [currentActor] = await tx.$queryRaw<
        { role: Role; status: UserStatus }[]
      >`SELECT "role", "status" FROM "User" WHERE "id" = ${actor.id} FOR SHARE`;
      if (!currentActor)
        throw new DomainError(
          "FORBIDDEN",
          "Super administrator access is required.",
          403,
        );
      if (currentActor.status !== "ACTIVE")
        throw new DomainError(
          "USER_INACTIVE",
          "Your account is not active.",
          403,
        );
      assertSuperAdmin({ id: actor.id, role: currentActor.role });
      await tx.$queryRaw`SELECT set_config('app.company_money_editor_id', ${actor.id}, true)`;
      return operation(tx);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}

function normalizedFields(input: CompanyMoneyInput) {
  return {
    type: input.type,
    amount: new Prisma.Decimal(input.amount).toFixed(2),
    date: input.date,
    note: input.note || null,
  };
}

function conflict() {
  return new DomainError(
    "TRANSACTION_CONFLICT",
    "This record changed. Refresh and review it before trying again.",
    409,
  );
}

async function existingReceipt(
  tx: Prisma.TransactionClient,
  actor: Actor,
  requestId: string,
  operation: CompanyMoneyMutationOperation,
  payload: Prisma.InputJsonObject,
  transactionId?: string,
) {
  const receipt = await tx.companyMoneyMutationReceipt.findUnique({
    where: { requestId },
  });
  if (
    receipt &&
    (receipt.actorId !== actor.id ||
      receipt.operation !== operation ||
      (transactionId !== undefined &&
        receipt.transactionId !== transactionId) ||
      !isDeepStrictEqual(receipt.payload, payload))
  )
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "This request was already used for a different company money transaction.",
      409,
    );
  return receipt;
}

async function replayRecord(
  tx: Prisma.TransactionClient,
  receipt: CompanyMoneyMutationReceipt,
) {
  const record = await tx.companyMoneyTransaction.findUnique({
    where: { id: receipt.transactionId },
    include: transactionInclude,
  });
  if (!record)
    throw new DomainError(
      "TRANSACTION_DELETED",
      "This record was deleted. Refresh the transaction history.",
      409,
    );
  if (record.version !== receipt.resultVersion) throw conflict();
  return transactionDTO(record);
}

function snapshot(record: TransactionWithActor) {
  return {
    requestId: record.requestId,
    version: record.version,
    type: record.type,
    amount: record.amount.toFixed(2),
    date: record.date.toISOString().slice(0, 10),
    note: record.note,
    createdById: record.createdById,
    createdAt: record.createdAt.toISOString(),
  };
}

async function assertResultingBalance(
  tx: Prisma.TransactionClient,
  previous?: TransactionWithActor,
  fields?: ReturnType<typeof normalizedFields>,
) {
  const oldAmount = previous
    ? previous.type === "ADD"
      ? previous.amount
      : previous.amount.negated()
    : new Prisma.Decimal(0);
  const newAmount = fields
    ? fields.type === "ADD"
      ? new Prisma.Decimal(fields.amount)
      : new Prisma.Decimal(fields.amount).negated()
    : new Prisma.Decimal(0);
  // Keep all aggregate arithmetic in PostgreSQL numeric, including large sums.
  const [result] = await tx.$queryRaw<{ insufficient: boolean }[]>`
    SELECT COALESCE(SUM(CASE WHEN "type" = 'ADD' THEN "amount" ELSE -"amount" END), 0)
      - ${oldAmount}::numeric + ${newAmount}::numeric < 0 AS insufficient
    FROM "CompanyMoneyTransaction"
  `;
  if (result.insufficient)
    throw new DomainError(
      "INSUFFICIENT_COMPANY_BALANCE",
      "This change would make the company balance negative.",
      409,
    );
}

async function currentRecord(
  tx: Prisma.TransactionClient,
  id: string,
  expectedVersion: number,
) {
  const initial = await tx.companyMoneyTransaction.findUnique({
    where: { id },
    include: transactionInclude,
  });
  if (!initial)
    throw new DomainError(
      "NOT_FOUND",
      "The requested transaction was not found.",
      404,
    );
  // Account deletion redacts audits before detaching financial references.
  // Hold the original author until our new audit commits, then re-read because
  // a deletion may already have finished while this shared lock was waiting.
  // No financial row lock is held while acquiring the author lock.
  if (initial.createdById)
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${initial.createdById} FOR SHARE`;
  const record = await tx.companyMoneyTransaction.findUnique({
    where: { id },
    include: transactionInclude,
  });
  if (!record)
    throw new DomainError(
      "NOT_FOUND",
      "The requested transaction was not found.",
      404,
    );
  if (record.version !== expectedVersion) throw conflict();
  return record;
}

export async function recordCompanyMoneyTransaction(
  actor: Actor,
  raw: unknown,
): Promise<CompanyMoneyTransactionRecord> {
  assertSuperAdmin(actor);
  const input = companyMoneyInputSchema.parse(raw);
  const fields = normalizedFields(input);
  return writeTransaction(actor, async (tx) => {
    const receipt = await existingReceipt(
      tx,
      actor,
      input.requestId,
      "CREATE",
      fields,
    );
    if (receipt) return replayRecord(tx, receipt);
    await assertResultingBalance(tx, undefined, fields);
    const record = await tx.companyMoneyTransaction.create({
      data: {
        ...fields,
        requestId: input.requestId,
        date: new Date(`${input.date}T00:00:00.000Z`),
        createdById: actor.id,
      },
      include: transactionInclude,
    });
    // The database captures an immutable CREATE receipt, including for older clients.
    await writeAudit(
      actor.id,
      input.type === "ADD" ? "COMPANY_MONEY_ADDED" : "COMPANY_MONEY_REMOVED",
      "CompanyMoneyTransaction",
      record.id,
      undefined,
      snapshot(record),
      tx,
    );
    return transactionDTO(record);
  });
}

export async function updateCompanyMoneyTransaction(
  actor: Actor,
  id: string,
  raw: unknown,
): Promise<CompanyMoneyTransactionRecord> {
  assertSuperAdmin(actor);
  idSchema.parse(id);
  const input = companyMoneyUpdateSchema.parse(raw);
  const fields = normalizedFields(input);
  const payload = { ...fields, expectedVersion: input.expectedVersion };
  return writeTransaction(actor, async (tx) => {
    const receipt = await existingReceipt(
      tx,
      actor,
      input.requestId,
      "UPDATE",
      payload,
      id,
    );
    if (receipt) return replayRecord(tx, receipt);
    const previous = await currentRecord(tx, id, input.expectedVersion);
    await assertResultingBalance(tx, previous, fields);
    const updated = await tx.companyMoneyTransaction.update({
      where: { id, version: input.expectedVersion },
      data: {
        ...fields,
        date: new Date(`${input.date}T00:00:00.000Z`),
        version: { increment: 1 },
      },
      include: transactionInclude,
    });
    await tx.companyMoneyMutationReceipt.create({
      data: {
        requestId: input.requestId,
        operation: "UPDATE",
        transactionId: id,
        actorId: actor.id,
        payload,
        resultVersion: updated.version,
      },
    });
    await writeAudit(
      actor.id,
      "COMPANY_MONEY_UPDATED",
      "CompanyMoneyTransaction",
      id,
      snapshot(previous),
      snapshot(updated),
      tx,
    );
    return transactionDTO(updated);
  });
}

export async function deleteCompanyMoneyTransaction(
  actor: Actor,
  id: string,
  raw: unknown,
): Promise<{ id: string }> {
  assertSuperAdmin(actor);
  idSchema.parse(id);
  const input = companyMoneyDeleteSchema.parse(raw);
  const payload = { expectedVersion: input.expectedVersion };
  return writeTransaction(actor, async (tx) => {
    const receipt = await existingReceipt(
      tx,
      actor,
      input.requestId,
      "DELETE",
      payload,
      id,
    );
    if (receipt) return { id };
    const previous = await currentRecord(tx, id, input.expectedVersion);
    await assertResultingBalance(tx, previous);
    await tx.companyMoneyTransaction.delete({
      where: { id, version: input.expectedVersion },
    });
    await tx.companyMoneyMutationReceipt.create({
      data: {
        requestId: input.requestId,
        operation: "DELETE",
        transactionId: id,
        actorId: actor.id,
        payload,
        resultVersion: previous.version,
      },
    });
    await writeAudit(
      actor.id,
      "COMPANY_MONEY_DELETED",
      "CompanyMoneyTransaction",
      id,
      snapshot(previous),
      { id, deleted: true },
      tx,
    );
    return { id };
  });
}
