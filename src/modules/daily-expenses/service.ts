import "server-only";
import { createHash } from "node:crypto";
import { Prisma, type DailyExpenseCategory } from "@prisma/client";
import { db } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit/service";
import {
  balanceInputSchema,
  expenseInputSchema,
  categoryCreateSchema,
  categoryUpdateSchema,
  dailyExpenseIdSchema,
  historyQuerySchema,
  todayInTimezone,
  type DailyExpenseCategoryDTO,
  type DailyExpenseSummaryDTO,
  type DailyExpenseTransactionDTO,
  type DailyExpenseHistoryDTO,
  type DailyExpenseMutationDTO,
  type DailyExpenseTransactionType,
} from "./contracts";
import { authorizeDailyExpenses, type DailyExpensesActor } from "./permissions";

const workspaceKey = "daily-expenses";
const transactionInclude = {
  category: true,
  createdBy: { select: { id: true, name: true, email: true } },
} satisfies Prisma.DailyExpenseTransactionInclude;
type TransactionWithRelations = Prisma.DailyExpenseTransactionGetPayload<{
  include: typeof transactionInclude;
}>;

function categoryDTO(category: DailyExpenseCategory): DailyExpenseCategoryDTO {
  return {
    id: category.id,
    name: category.name,
    archived: category.archived,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
  };
}

function transactionDTO(
  transaction: TransactionWithRelations,
): DailyExpenseTransactionDTO {
  return {
    id: transaction.id,
    type: transaction.type,
    amount: transaction.amount.toFixed(2),
    date: transaction.date.toISOString().slice(0, 10),
    note: transaction.note,
    category: transaction.category ? categoryDTO(transaction.category) : null,
    createdBy: transaction.createdBy,
    createdAt: transaction.createdAt.toISOString(),
  };
}

function initialConfiguration() {
  const currency = (process.env.DAILY_EXPENSES_CURRENCY ?? "BDT")
    .trim()
    .toUpperCase();
  const timezone = (process.env.DAILY_EXPENSES_TIMEZONE ?? "Asia/Dhaka").trim();
  try {
    if (
      !/^[A-Z]{3}$/.test(currency) ||
      !Intl.supportedValuesOf("currency").includes(currency)
    ) {
      throw new Error("Unsupported currency");
    }
    const options = new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions();
    if (
      options.maximumFractionDigits !== 2 ||
      options.minimumFractionDigits !== 2
    ) {
      throw new Error(
        "This ledger requires a currency with two decimal places",
      );
    }
    // Intl accepts raw numeric offsets but PostgreSQL uses the opposite POSIX
    // sign for them. Named IANA zones keep validation and database dates aligned.
    if (
      timezone.length > 100 ||
      !(
        timezone === "UTC" ||
        timezone === "GMT" ||
        /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)+$/.test(timezone)
      )
    ) {
      throw new Error("Invalid timezone");
    }
    todayInTimezone(timezone);
  } catch {
    throw new DomainError(
      "DAILY_EXPENSES_CONFIGURATION",
      "Configure a valid two-decimal DAILY_EXPENSES_CURRENCY and DAILY_EXPENSES_TIMEZONE before creating the ledger.",
      500,
    );
  }
  return { currency, timezone };
}

function isUniqueConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/** Scope is always derived here, never accepted from API or service callers. */
async function getLedger() {
  const existing = await db.dailyExpenseLedger.findUnique({
    where: { workspaceKey },
  });
  if (existing) return existing;
  try {
    return await db.dailyExpenseLedger.create({
      data: { workspaceKey, ...initialConfiguration() },
    });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    // Another administrator may have opened the workspace simultaneously.
    const ledger = await db.dailyExpenseLedger.findUnique({
      where: { workspaceKey },
    });
    if (!ledger) throw error;
    return ledger;
  }
}

export async function getDailyExpensesSummary(
  actor: DailyExpensesActor,
): Promise<DailyExpenseSummaryDTO> {
  authorizeDailyExpenses(actor);
  const ledger = await getLedger();
  // All totals share a single PostgreSQL statement snapshot. Compute subtraction
  // in exact numeric SQL too: aggregate totals may exceed Decimal(18,2).
  const [totals] = await db.$queryRaw<
    Array<{
      currentBalance: string;
      totalBalanceAdded: string;
      totalExpenses: string;
    }>
  >(Prisma.sql`
    SELECT
      COALESCE(SUM(CASE WHEN "type" = 'BALANCE_ADDED' THEN "amount" ELSE -"amount" END), 0)::text AS "currentBalance",
      COALESCE(SUM("amount") FILTER (WHERE "type" = 'BALANCE_ADDED'), 0)::text AS "totalBalanceAdded",
      COALESCE(SUM("amount") FILTER (WHERE "type" = 'EXPENSE'), 0)::text AS "totalExpenses"
    FROM "DailyExpenseTransaction" WHERE "ledgerId" = ${ledger.id}
  `);
  // Decimal construction and fixed-point serialization do not use JS Number or
  // perform arithmetic; zero is normalized to the same two-decimal contract.
  return {
    ledger: {
      id: ledger.id,
      currency: ledger.currency,
      timezone: ledger.timezone,
    },
    currentBalance: new Prisma.Decimal(totals.currentBalance).toFixed(2),
    totalBalanceAdded: new Prisma.Decimal(totals.totalBalanceAdded).toFixed(2),
    totalExpenses: new Prisma.Decimal(totals.totalExpenses).toFixed(2),
    today: todayInTimezone(ledger.timezone),
  };
}

export async function listDailyExpenseTransactions(
  actor: DailyExpensesActor,
  raw: unknown = {},
): Promise<DailyExpenseHistoryDTO> {
  authorizeDailyExpenses(actor);
  const filters = historyQuerySchema.parse(raw);
  const ledger = await getLedger();
  if (filters.categoryId) {
    const category = await db.dailyExpenseCategory.findFirst({
      where: { id: filters.categoryId, ledgerId: ledger.id },
      select: { id: true },
    });
    if (!category)
      throw new DomainError(
        "INVALID_CATEGORY",
        "Choose a category from this ledger.",
      );
  }
  const where: Prisma.DailyExpenseTransactionWhereInput = {
    ledgerId: ledger.id,
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(filters.search
      ? {
          note: {
            contains: filters.search.replace(/[\\%_]/g, "\\$&"),
            mode: "insensitive",
          },
        }
      : {}),
    ...(filters.from || filters.to
      ? {
          date: {
            ...(filters.from
              ? { gte: new Date(`${filters.from}T00:00:00.000Z`) }
              : {}),
            ...(filters.to
              ? { lte: new Date(`${filters.to}T00:00:00.000Z`) }
              : {}),
          },
        }
      : {}),
  };
  const [total, items] = await db.$transaction(
    [
      db.dailyExpenseTransaction.count({ where }),
      db.dailyExpenseTransaction.findMany({
        where,
        include: transactionInclude,
        orderBy: [{ date: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  return {
    items: items.map(transactionDTO),
    total,
    page: filters.page,
    pageSize: filters.pageSize,
    totalPages: Math.ceil(total / filters.pageSize),
  };
}

type NormalizedTransactionInput = {
  amount: string;
  date: string;
  note?: string;
  idempotencyKey: string;
  categoryId?: string;
};

async function postTransaction(
  actor: DailyExpensesActor,
  type: DailyExpenseTransactionType,
  input: NormalizedTransactionInput,
): Promise<DailyExpenseMutationDTO> {
  const ledger = await getLedger();
  const payload = {
    type,
    amount: input.amount,
    date: input.date,
    categoryId: type === "EXPENSE" ? input.categoryId! : null,
    note: input.note || null,
  };
  const payloadHash = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  const uniqueKey = {
    ledgerId_idempotencyKey: {
      ledgerId: ledger.id,
      idempotencyKey: input.idempotencyKey,
    },
  };
  function replay(existing: TransactionWithRelations): DailyExpenseMutationDTO {
    if (
      existing.createdById !== actor.id ||
      existing.payloadHash !== payloadHash
    ) {
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "This submission key was already used for different transaction data. Start a new submission.",
        409,
      );
    }
    return { transaction: transactionDTO(existing), replayed: true };
  }
  // Safe retries are checked before category state: archiving after a successful
  // save must never turn its retry into another financial operation or an error.
  const existing = await db.dailyExpenseTransaction.findUnique({
    where: uniqueKey,
    include: transactionInclude,
  });
  if (existing) return replay(existing);
  if (input.date > todayInTimezone(ledger.timezone)) {
    throw new DomainError(
      "FUTURE_DATE",
      "Use today or an earlier transaction date.",
    );
  }
  try {
    const transaction = await db.$transaction(async (tx) => {
      if (type === "EXPENSE") {
        const categories = await tx.$queryRaw<
          Array<{ id: string; archived: boolean }>
        >(Prisma.sql`
          SELECT "id", "archived" FROM "DailyExpenseCategory"
          WHERE "id" = ${input.categoryId} AND "ledgerId" = ${ledger.id} FOR SHARE
        `);
        if (!categories[0] || categories[0].archived) {
          throw new DomainError(
            "INVALID_CATEGORY",
            "Choose an active category from this ledger.",
          );
        }
      }
      const created = await tx.dailyExpenseTransaction.create({
        data: {
          ledgerId: ledger.id,
          type,
          amount: new Prisma.Decimal(input.amount),
          date: new Date(`${input.date}T00:00:00.000Z`),
          categoryId: payload.categoryId,
          note: payload.note,
          createdById: actor.id,
          idempotencyKey: input.idempotencyKey,
          payloadHash,
        },
        include: transactionInclude,
      });
      await writeAudit(
        actor.id,
        "DAILY_EXPENSE_TRANSACTION_CREATED",
        "DailyExpenseTransaction",
        created.id,
        undefined,
        transactionDTO(created),
        tx,
      );
      return created;
    });
    return { transaction: transactionDTO(transaction), replayed: false };
  } catch (error) {
    // Uniqueness is enforced by PostgreSQL. Re-read after rollback so concurrent
    // identical submissions return the winner. Also covers an archive racing a
    // duplicate request after the first request has already committed.
    const winner = await db.dailyExpenseTransaction.findUnique({
      where: uniqueKey,
      include: transactionInclude,
    });
    if (winner) return replay(winner);
    throw error;
  }
}

export async function addDailyExpenseBalance(
  actor: DailyExpensesActor,
  raw: unknown,
): Promise<DailyExpenseMutationDTO> {
  authorizeDailyExpenses(actor);
  return postTransaction(actor, "BALANCE_ADDED", balanceInputSchema.parse(raw));
}

export async function addDailyExpense(
  actor: DailyExpensesActor,
  raw: unknown,
): Promise<DailyExpenseMutationDTO> {
  authorizeDailyExpenses(actor);
  return postTransaction(actor, "EXPENSE", expenseInputSchema.parse(raw));
}

export async function listDailyExpenseCategories(
  actor: DailyExpensesActor,
): Promise<DailyExpenseCategoryDTO[]> {
  authorizeDailyExpenses(actor);
  const ledger = await getLedger();
  const categories = await db.dailyExpenseCategory.findMany({
    where: { ledgerId: ledger.id },
    orderBy: [{ archived: "asc" }, { name: "asc" }, { id: "asc" }],
  });
  return categories.map(categoryDTO);
}

export async function createDailyExpenseCategory(
  actor: DailyExpensesActor,
  raw: unknown,
): Promise<DailyExpenseCategoryDTO> {
  authorizeDailyExpenses(actor);
  const input = categoryCreateSchema.parse(raw);
  const ledger = await getLedger();
  try {
    return await db.$transaction(async (tx) => {
      const category = await tx.dailyExpenseCategory.create({
        data: { ledgerId: ledger.id, name: input.name },
      });
      await writeAudit(
        actor.id,
        "DAILY_EXPENSE_CATEGORY_CREATED",
        "DailyExpenseCategory",
        category.id,
        undefined,
        categoryDTO(category),
        tx,
      );
      return categoryDTO(category);
    });
  } catch (error) {
    if (isUniqueConflict(error))
      throw new DomainError(
        "CATEGORY_CONFLICT",
        "A category with this name already exists, including archived categories.",
        409,
      );
    throw error;
  }
}

export async function updateDailyExpenseCategory(
  actor: DailyExpensesActor,
  id: string,
  raw: unknown,
): Promise<DailyExpenseCategoryDTO> {
  authorizeDailyExpenses(actor);
  dailyExpenseIdSchema.parse(id);
  const input = categoryUpdateSchema.parse(raw);
  const ledger = await getLedger();
  try {
    return await db.$transaction(async (tx) => {
      // Serialize category mutations and keep their audit before/after snapshots
      // accurate. FOR UPDATE conflicts with the shared locks held by expenses.
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "DailyExpenseCategory" WHERE "id" = ${id} AND "ledgerId" = ${ledger.id} FOR UPDATE
      `);
      if (!rows.length)
        throw new DomainError(
          "NOT_FOUND",
          "The requested category was not found.",
          404,
        );
      const previous = await tx.dailyExpenseCategory.findUniqueOrThrow({
        where: { id },
      });
      const category = await tx.dailyExpenseCategory.update({
        where: { id },
        data: input,
      });
      await writeAudit(
        actor.id,
        "DAILY_EXPENSE_CATEGORY_UPDATED",
        "DailyExpenseCategory",
        id,
        categoryDTO(previous),
        categoryDTO(category),
        tx,
      );
      return categoryDTO(category);
    });
  } catch (error) {
    if (isUniqueConflict(error))
      throw new DomainError(
        "CATEGORY_CONFLICT",
        "A category with this name already exists, including archived categories.",
        409,
      );
    throw error;
  }
}
