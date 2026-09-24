import "server-only";
import type { Prisma } from "@prisma/client";
import type { DailyExpenseReportFilters } from "./contracts";

/** History and exports share exact dates, literal note search, and live rows. */
export function dailyExpenseWhere(
  ledgerId: string,
  filters: DailyExpenseReportFilters,
): Prisma.DailyExpenseTransactionWhereInput {
  return {
    ledgerId,
    deletedAt: null,
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
}
