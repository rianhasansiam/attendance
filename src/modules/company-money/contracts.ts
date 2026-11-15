import { z } from "zod";

export type CompanyMoneyTransactionType = "ADD" | "REMOVE";

export type CompanyMoneyInput = {
  requestId: string;
  type: CompanyMoneyTransactionType;
  amount: string;
  date: string;
  note?: string;
};

export type CompanyMoneyListArgs = {
  page?: number;
  pageSize?: number;
  search?: string;
};

export type CompanyMoneyUpdateInput = CompanyMoneyInput & {
  expectedVersion: number;
};

export type CompanyMoneyDeleteInput = {
  requestId: string;
  expectedVersion: number;
};

export type CompanyMoneyTransactionRecord = {
  id: string;
  version: number;
  type: CompanyMoneyTransactionType;
  amount: string;
  date: string;
  note: string | null;
  createdAt: string;
  createdBy: { name: string | null; email: string } | null;
};

export type CompanyMoneyOverview = {
  balance: string;
  totalAdded: string;
  totalRemoved: string;
  items: CompanyMoneyTransactionRecord[];
  total: number;
  page: number;
  pageSize: number;
};

export type CompanyMoneyReportFilters = { from?: string; to?: string };

export type CompanyMoneyReportData = {
  filters: CompanyMoneyReportFilters;
  generatedAt: string;
  summary: {
    openingBalance: string;
    totalAdded: string;
    totalRemoved: string;
    closingBalance: string;
    count: number;
  };
  items: CompanyMoneyTransactionRecord[];
};

const transactionDateSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0001-01-01") return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}, "Enter a valid date in YYYY-MM-DD format.");

export const companyMoneyReportQuerySchema = z
  .object({
    from: transactionDateSchema.optional(),
    to: transactionDateSchema.optional(),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: "The start date must be on or before the end date.",
    path: ["to"],
  });

export const companyMoneyInputSchema = z
  .object({
    requestId: z.uuid(),
    type: z.enum(["ADD", "REMOVE"]),
    date: transactionDateSchema,
    amount: z
      .string()
      .trim()
      .regex(
        /^\d{1,10}(?:\.\d{1,2})?$/,
        "Enter an amount with at most two decimal places.",
      )
      .refine(
        (value) => /[1-9]/.test(value),
        "Enter an amount greater than zero.",
      ),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export const companyMoneyUpdateSchema = companyMoneyInputSchema.extend({
  expectedVersion: z.number().int().min(1).max(2147483646),
});

export const companyMoneyDeleteSchema = z
  .object({
    requestId: z.uuid(),
    expectedVersion: z.number().int().min(1).max(2147483647),
  })
  .strict();

function pageNumber(maximum: number, fallback: number) {
  return z
    .union([
      z.number(),
      z
        .string()
        .regex(/^\d{1,6}$/)
        .transform(Number),
    ])
    .pipe(z.number().int().min(1).max(maximum))
    .default(fallback);
}

export const companyMoneyListSchema = z
  .object({
    page: pageNumber(100000, 1),
    pageSize: pageNumber(100, 20),
    search: z.string().trim().max(200).optional(),
  })
  .strict();
