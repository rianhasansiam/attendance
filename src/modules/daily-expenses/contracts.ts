import { z } from "zod";

export type DailyExpenseTransactionType = "BALANCE_ADDED" | "EXPENSE";
export type DailyExpenseLedgerDTO = {
  id: string;
  currency: string;
  timezone: string;
};
export type DailyExpenseSummaryDTO = {
  ledger: DailyExpenseLedgerDTO;
  currentBalance: string;
  totalBalanceAdded: string;
  totalExpenses: string;
  today: string;
};
export type DailyExpenseCategoryDTO = {
  id: string;
  name: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};
export type DailyExpenseTransactionDTO = {
  id: string;
  version: number;
  type: DailyExpenseTransactionType;
  amount: string;
  date: string;
  note: string | null;
  category: DailyExpenseCategoryDTO | null;
  createdBy: { id: string; name: string | null; email: string };
  createdAt: string;
};
export type DailyExpenseHistoryDTO = {
  items: DailyExpenseTransactionDTO[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};
export type DailyExpenseMutationDTO = {
  transaction: DailyExpenseTransactionDTO;
  replayed: boolean;
};
export type DailyExpenseDeletionDTO = {
  id: string;
  replayed: boolean;
};
export type DailyExpenseTotalsDTO = {
  currentBalance: string;
  totalBalanceAdded: string;
  totalExpenses: string;
};
export type DailyExpenseReportData = {
  ledger: DailyExpenseLedgerDTO;
  generatedAt: string;
  filters: DailyExpenseReportFilters;
  categoryName: string | null;
  allTime: DailyExpenseTotalsDTO;
  filtered: {
    count: number;
    totalBalanceAdded: string;
    totalExpenses: string;
    netChange: string;
  };
  items: DailyExpenseTransactionDTO[];
};

/** Only decimal text reaches Prisma. Canonicalization never rounds. */
export const amountSchema = z
  .string()
  .trim()
  .regex(
    /^\d{1,16}(?:\.\d{1,2})?$/,
    "Enter a positive amount with at most 16 whole digits and 2 decimal places.",
  )
  .refine((value) => /[1-9]/.test(value), "Amount must be greater than zero.")
  .transform((value) => {
    const [whole, fraction = ""] = value.split(".");
    return `${whole.replace(/^0+(?=\d)/, "")}.${fraction.padEnd(2, "0")}`;
  });

export const businessDateSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0001-01-01") return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}, "Enter a valid date in YYYY-MM-DD format.");

export const dailyExpenseIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const idempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid submission key.");
const noteSchema = z
  .string()
  .trim()
  .max(1000, "Use no more than 1,000 characters.")
  .optional();
const transactionFields = {
  amount: amountSchema,
  date: businessDateSchema,
  note: noteSchema,
  idempotencyKey: idempotencyKeySchema,
};
export const balanceInputSchema = z.object(transactionFields).strict();
export const expenseInputSchema = z
  .object({ ...transactionFields, categoryId: dailyExpenseIdSchema })
  .strict();
// Leave room for the next PostgreSQL INTEGER version without overflow.
const transactionVersionSchema = z.number().int().min(1).max(2147483646);
export const transactionUpdateSchema = z
  .object({
    amount: amountSchema,
    date: businessDateSchema,
    note: noteSchema,
    categoryId: dailyExpenseIdSchema.nullable().optional(),
    expectedVersion: transactionVersionSchema,
  })
  .strict();
export const transactionDeleteSchema = z
  .object({ expectedVersion: transactionVersionSchema })
  .strict();
const categoryNameSchema = z
  .string()
  .transform((value) => value.normalize("NFKC").trim())
  .pipe(
    z
      .string()
      .min(1, "Enter a category name.")
      .max(80, "Use no more than 80 characters."),
  );
export const categoryCreateSchema = z
  .object({ name: categoryNameSchema })
  .strict();
export const categoryUpdateSchema = z
  .object({
    name: categoryNameSchema.optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.name !== undefined || value.archived !== undefined,
    "Provide a name or archive state.",
  );

function pageNumber(max: number, fallback: number) {
  return z
    .union([
      z.number(),
      z
        .string()
        .regex(/^\d{1,6}$/)
        .transform(Number),
    ])
    .pipe(z.number().int().min(1).max(max))
    .default(fallback);
}
const dailyExpenseFilterFields = {
  from: businessDateSchema.optional(),
  to: businessDateSchema.optional(),
  type: z.enum(["BALANCE_ADDED", "EXPENSE"]).optional(),
  categoryId: dailyExpenseIdSchema.optional(),
  search: z.string().trim().max(200).optional(),
};
export const historyQuerySchema = z
  .object({
    ...dailyExpenseFilterFields,
    page: pageNumber(100000, 1),
    pageSize: pageNumber(100, 20),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: "The start date must be on or before the end date.",
    path: ["to"],
  });

export const dailyExpenseReportQuerySchema = z.preprocess(
  (raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return raw;
    // Pagination is the only ignored input. Keep all other unknown fields so
    // strict validation rejects forged actor or ledger scope.
    const filters = { ...raw } as Record<string, unknown>;
    delete filters.page;
    delete filters.pageSize;
    return filters;
  },
  z
    .object(dailyExpenseFilterFields)
    .strict()
    .refine((value) => !value.from || !value.to || value.from <= value.to, {
      message: "The start date must be on or before the end date.",
      path: ["to"],
    }),
);

export type BalanceInput = z.input<typeof balanceInputSchema>;
export type ExpenseInput = z.input<typeof expenseInputSchema>;
export type TransactionUpdateInput = z.input<typeof transactionUpdateSchema>;
export type TransactionDeleteInput = z.input<typeof transactionDeleteSchema>;
export type CategoryCreateInput = z.input<typeof categoryCreateSchema>;
export type CategoryUpdateInput = z.input<typeof categoryUpdateSchema>;
export type HistoryQuery = z.input<typeof historyQuerySchema>;
export type ParsedHistoryQuery = z.output<typeof historyQuerySchema>;
export type DailyExpenseReportFilters = z.output<
  typeof dailyExpenseReportQuerySchema
>;

export function todayInTimezone(
  timezone: string,
  now: Date = new Date(),
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Format text directly, retaining every cent even beyond Number.MAX_SAFE_INTEGER. */
export function formatMoney(amount: string, currency: string): string {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
  if (!match) throw new Error("Invalid decimal money value.");
  const [, sign, whole, fraction = ""] = match;
  return `${sign}${currency} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction.padEnd(2, "0")}`;
}
