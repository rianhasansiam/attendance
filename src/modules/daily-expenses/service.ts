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
  dailyExpenseReportQuerySchema,
  transactionUpdateSchema,
  transactionDeleteSchema,
  todayInTimezone,
  type DailyExpenseCategoryDTO,
  type DailyExpenseSummaryDTO,
  type DailyExpenseTransactionDTO,
  type DailyExpenseHistoryDTO,
  type DailyExpenseMutationDTO,
  type DailyExpenseDeletionDTO,
  type DailyExpenseReportData,
  type DailyExpenseTotalsDTO,
  type DailyExpenseTransactionType,
} from "./contracts";
import {
  authorizeDailyExpenses,
  authorizeDailyExpenseWrite,
  authorizeDailyExpenseTransactionEdit,
  authorizeDailyExpenseTransactionDelete,
  authorizeDailyExpenseReport,
  type DailyExpensesActor,
} from "./permissions";
import { dailyExpenseWhere } from "./filters";

export const MAX_DAILY_EXPENSE_REPORT_ROWS = 10000;

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
    version: transaction.version,
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

async function dailyExpenseTotals(
  client: Pick<Prisma.TransactionClient, "$queryRaw">,
  ledgerId: string,
): Promise<DailyExpenseTotalsDTO> {
  // All totals share a single PostgreSQL statement snapshot. Compute subtraction
  // in exact numeric SQL too: aggregate totals may exceed Decimal(18,2).
  const [totals] = await client.$queryRaw<
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
    FROM "DailyExpenseTransaction" WHERE "ledgerId" = ${ledgerId} AND "deletedAt" IS NULL
  `);
  // Decimal construction and fixed-point serialization do not use JS Number or
  // perform arithmetic; zero is normalized to the same two-decimal contract.
  return {
    currentBalance: new Prisma.Decimal(totals.currentBalance).toFixed(2),
    totalBalanceAdded: new Prisma.Decimal(totals.totalBalanceAdded).toFixed(2),
    totalExpenses: new Prisma.Decimal(totals.totalExpenses).toFixed(2),
  };
}

export async function getDailyExpensesSummary(
  actor: DailyExpensesActor,
): Promise<DailyExpenseSummaryDTO> {
  authorizeDailyExpenses(actor);
  const ledger = await getLedger();
  return {
    ledger: {
      id: ledger.id,
      currency: ledger.currency,
      timezone: ledger.timezone,
    },
    ...(await dailyExpenseTotals(db, ledger.id)),
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
  const where = dailyExpenseWhere(ledger.id, filters);
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

export async function getDailyExpenseReportData(
  actor: DailyExpensesActor,
  raw: unknown = {},
): Promise<DailyExpenseReportData> {
  authorizeDailyExpenseReport(actor);
  const filters = dailyExpenseReportQuerySchema.parse(raw);
  const ledger = await getLedger();

  return db.$transaction(
    async (tx) => {
      const generatedAt = new Date().toISOString();
      let categoryName: string | null = null;
      if (filters.categoryId) {
        const category = await tx.dailyExpenseCategory.findFirst({
          where: { id: filters.categoryId, ledgerId: ledger.id },
          select: { name: true },
        });
        if (!category) {
          throw new DomainError(
            "INVALID_CATEGORY",
            "Choose a category from this ledger.",
          );
        }
        categoryName = category.name;
      }
      const records = await tx.dailyExpenseTransaction.findMany({
        where: dailyExpenseWhere(ledger.id, filters),
        include: transactionInclude,
        orderBy: [{ date: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        take: MAX_DAILY_EXPENSE_REPORT_ROWS + 1,
      });
      if (records.length > MAX_DAILY_EXPENSE_REPORT_ROWS) {
        throw new DomainError(
          "REPORT_TOO_LARGE",
          "Choose narrower filters to export 10,000 Daily Expenses records or fewer.",
        );
      }
      const allTime = await dailyExpenseTotals(tx, ledger.id);
      // 10,000 maximum Decimal(18,2) amounts need 22 significant digits. Use an
      // isolated wider context so accumulated cents never round at precision 20.
      const ExactDecimal = Prisma.Decimal.clone({ precision: 40 });
      let added = new ExactDecimal(0);
      let expenses = new ExactDecimal(0);
      for (const record of records) {
        if (record.type === "BALANCE_ADDED")
          added = added.add(record.amount.toString());
        else expenses = expenses.add(record.amount.toString());
      }
      return {
        ledger: {
          id: ledger.id,
          currency: ledger.currency,
          timezone: ledger.timezone,
        },
        generatedAt,
        filters,
        categoryName,
        allTime,
        filtered: {
          count: records.length,
          totalBalanceAdded: added.toFixed(2),
          totalExpenses: expenses.toFixed(2),
          netChange: added.sub(expenses).toFixed(2),
        },
        items: records.map(transactionDTO),
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

type NormalizedTransactionInput = {
  amount: string;
  date: string;
  note?: string;
  idempotencyKey: string;
  categoryId?: string;
};

async function authorizePersistedWriter(
  tx: Prisma.TransactionClient,
  actor: DailyExpensesActor,
) {
  // Keep demotion or deactivation from racing a permitted write.
  const [currentActor] = await tx.$queryRaw<DailyExpensesActor[]>(Prisma.sql`
    SELECT "id", "role", "status" FROM "User" WHERE "id" = ${actor.id} FOR SHARE
  `);
  if (!currentActor) {
    throw new DomainError(
      "FORBIDDEN",
      "Your account cannot make changes to Daily Expenses.",
      403,
    );
  }
  authorizeDailyExpenseWrite(currentActor);
}

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
    if (existing.deletedAt) {
      throw new DomainError(
        "TRANSACTION_DELETED",
        "This transaction was deleted. Its original submission cannot be restored or submitted again.",
        409,
      );
    }
    return { transaction: transactionDTO(existing), replayed: true };
  }
  try {
    return await db.$transaction(async (tx) => {
      await authorizePersistedWriter(tx, actor);
      // Authorize retries too, then check them before category state: archiving
      // after a save must never turn a retry into another financial operation.
      const existing = await tx.dailyExpenseTransaction.findUnique({
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
      return { transaction: transactionDTO(created), replayed: false };
    });
  } catch (error) {
    if (error instanceof DomainError && error.status === 403) throw error;
    // Uniqueness is enforced by PostgreSQL. Re-read after rollback so concurrent
    // identical submissions return the winner. Also covers an archive racing a
    // duplicate request after the first request has already committed.
    return db.$transaction(async (tx) => {
      await authorizePersistedWriter(tx, actor);
      const winner = await tx.dailyExpenseTransaction.findUnique({
        where: uniqueKey,
        include: transactionInclude,
      });
      if (winner) return replay(winner);
      throw error;
    });
  }
}

export async function addDailyExpenseBalance(
  actor: DailyExpensesActor,
  raw: unknown,
): Promise<DailyExpenseMutationDTO> {
  authorizeDailyExpenseWrite(actor);
  return postTransaction(actor, "BALANCE_ADDED", balanceInputSchema.parse(raw));
}

export async function addDailyExpense(
  actor: DailyExpensesActor,
  raw: unknown,
): Promise<DailyExpenseMutationDTO> {
  authorizeDailyExpenseWrite(actor);
  return postTransaction(actor, "EXPENSE", expenseInputSchema.parse(raw));
}

export async function updateDailyExpenseTransaction(
  actor: DailyExpensesActor,
  id: string,
  raw: unknown,
): Promise<DailyExpenseMutationDTO> {
  authorizeDailyExpenseTransactionEdit(actor);
  dailyExpenseIdSchema.parse(id);
  const input = transactionUpdateSchema.parse(raw);

  return db.$transaction(async (tx) => {
    // The session role can become stale. Hold a shared user lock so a role or
    // status change cannot race the permission check and the financial update.
    const [currentActor] = await tx.$queryRaw<DailyExpensesActor[]>(Prisma.sql`
      SELECT "id", "role", "status" FROM "User" WHERE "id" = ${actor.id} FOR SHARE
    `);
    if (!currentActor) {
      throw new DomainError(
        "FORBIDDEN",
        "Your account cannot edit Daily Expenses records.",
        403,
      );
    }
    authorizeDailyExpenseTransactionEdit(currentActor);

    // An edit must target an existing record; it never creates a ledger.
    const ledger = await tx.dailyExpenseLedger.findUnique({
      where: { workspaceKey },
    });
    if (!ledger) {
      throw new DomainError(
        "NOT_FOUND",
        "The requested transaction was not found.",
        404,
      );
    }
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "DailyExpenseTransaction"
      WHERE "id" = ${id} AND "ledgerId" = ${ledger.id} FOR UPDATE
    `);
    if (!rows.length) {
      throw new DomainError(
        "NOT_FOUND",
        "The requested transaction was not found.",
        404,
      );
    }
    const previous = await tx.dailyExpenseTransaction.findUniqueOrThrow({
      where: { id },
      include: transactionInclude,
    });
    if (previous.deletedAt) {
      throw new DomainError(
        "TRANSACTION_DELETED",
        "This record was deleted. Refresh the transaction history.",
        409,
      );
    }
    const categoryId = input.categoryId ?? null;
    if (
      (previous.type === "EXPENSE" && categoryId === null) ||
      (previous.type === "BALANCE_ADDED" && categoryId !== null)
    ) {
      throw new DomainError(
        "INVALID_CATEGORY",
        previous.type === "EXPENSE"
          ? "Choose a category for this expense."
          : "Balance additions cannot have a category.",
      );
    }
    const note = input.note || null;
    const sameFields =
      previous.amount.toFixed(2) === input.amount &&
      previous.date.toISOString().slice(0, 10) === input.date &&
      previous.categoryId === categoryId &&
      previous.note === note;
    if (previous.version !== input.expectedVersion) {
      // A lost response can be retried with the frozen fields and old version.
      // A later intervening edit must never be overwritten by that retry.
      if (previous.version === input.expectedVersion + 1 && sameFields) {
        return { transaction: transactionDTO(previous), replayed: true };
      }
      throw new DomainError(
        "TRANSACTION_CONFLICT",
        "This record changed since you opened it. Refresh and review it before editing again.",
        409,
      );
    }
    if (input.date > todayInTimezone(ledger.timezone)) {
      throw new DomainError(
        "FUTURE_DATE",
        "Use today or an earlier transaction date.",
      );
    }
    if (previous.type === "EXPENSE") {
      const [category] = await tx.$queryRaw<
        Array<{ id: string; archived: boolean }>
      >(Prisma.sql`
        SELECT "id", "archived" FROM "DailyExpenseCategory"
        WHERE "id" = ${categoryId} AND "ledgerId" = ${ledger.id} FOR SHARE
      `);
      if (
        !category ||
        (category.archived && category.id !== previous.categoryId)
      ) {
        throw new DomainError(
          "INVALID_CATEGORY",
          "Choose an active category from this ledger.",
        );
      }
    }
    // Transaction-local state is discarded on commit/rollback and is safe with
    // pooled connections. The database guard independently checks this actor.
    await tx.$queryRaw(Prisma.sql`
      SELECT set_config('app.daily_expenses_editor_id', ${actor.id}, true)
    `);
    const updated = await tx.dailyExpenseTransaction.update({
      where: { id },
      data: {
        amount: new Prisma.Decimal(input.amount),
        date: new Date(`${input.date}T00:00:00.000Z`),
        note,
        categoryId,
        version: { increment: 1 },
      },
      include: transactionInclude,
    });
    await writeAudit(
      actor.id,
      "DAILY_EXPENSE_TRANSACTION_UPDATED",
      "DailyExpenseTransaction",
      id,
      transactionDTO(previous),
      transactionDTO(updated),
      tx,
    );
    return { transaction: transactionDTO(updated), replayed: false };
  });
}

export async function deleteDailyExpenseTransaction(
  actor: DailyExpensesActor,
  id: string,
  raw: unknown,
): Promise<DailyExpenseDeletionDTO> {
  authorizeDailyExpenseTransactionDelete(actor);
  dailyExpenseIdSchema.parse(id);
  const input = transactionDeleteSchema.parse(raw);

  return db.$transaction(async (tx) => {
    const [currentActor] = await tx.$queryRaw<DailyExpensesActor[]>(Prisma.sql`
      SELECT "id", "role", "status" FROM "User" WHERE "id" = ${actor.id} FOR SHARE
    `);
    if (!currentActor) {
      throw new DomainError(
        "FORBIDDEN",
        "Your account cannot delete Daily Expenses records.",
        403,
      );
    }
    authorizeDailyExpenseTransactionDelete(currentActor);

    const ledger = await tx.dailyExpenseLedger.findUnique({
      where: { workspaceKey },
    });
    if (!ledger) {
      throw new DomainError(
        "NOT_FOUND",
        "The requested transaction was not found.",
        404,
      );
    }
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "DailyExpenseTransaction"
      WHERE "id" = ${id} AND "ledgerId" = ${ledger.id} FOR UPDATE
    `);
    if (!rows.length) {
      throw new DomainError(
        "NOT_FOUND",
        "The requested transaction was not found.",
        404,
      );
    }
    const previous = await tx.dailyExpenseTransaction.findUniqueOrThrow({
      where: { id },
      include: transactionInclude,
    });
    // Keeping the row and original submission key lets retries confirm deletion
    // without issuing another audit or allowing the original POST to recreate it.
    if (previous.deletedAt) return { id, replayed: true };
    if (previous.version !== input.expectedVersion) {
      throw new DomainError(
        "TRANSACTION_CONFLICT",
        "This record changed since you opened it. Refresh and review it before deleting it.",
        409,
      );
    }
    await tx.$queryRaw(Prisma.sql`
      SELECT set_config('app.daily_expenses_editor_id', ${actor.id}, true)
    `);
    const deleted = await tx.dailyExpenseTransaction.update({
      where: { id },
      data: { deletedAt: new Date(), version: { increment: 1 } },
      include: transactionInclude,
    });
    await writeAudit(
      actor.id,
      "DAILY_EXPENSE_TRANSACTION_DELETED",
      "DailyExpenseTransaction",
      id,
      { ...transactionDTO(previous), deletedAt: null },
      {
        ...transactionDTO(deleted),
        deletedAt: deleted.deletedAt!.toISOString(),
      },
      tx,
    );
    return { id, replayed: false };
  });
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
  authorizeDailyExpenseWrite(actor);
  const input = categoryCreateSchema.parse(raw);
  const ledger = await getLedger();
  try {
    return await db.$transaction(async (tx) => {
      await authorizePersistedWriter(tx, actor);
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
  authorizeDailyExpenseWrite(actor);
  dailyExpenseIdSchema.parse(id);
  const input = categoryUpdateSchema.parse(raw);
  const ledger = await getLedger();
  try {
    return await db.$transaction(async (tx) => {
      await authorizePersistedWriter(tx, actor);
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
