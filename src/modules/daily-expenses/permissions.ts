import { DomainError } from "@/lib/errors";

export type DailyExpensesActor = { id: string; role: string; status?: string };

/** Shared by navigation and every server entry point; independent of Employee. */
export function canManageDailyExpenses(role: string): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

export function canEditDailyExpenseTransactions(role: string): boolean {
  return role === "SUPER_ADMIN";
}

export function canDeleteDailyExpenseTransactions(role: string): boolean {
  return role === "SUPER_ADMIN";
}

export function canDownloadDailyExpenseReport(role: string): boolean {
  return role === "SUPER_ADMIN";
}

export function authorizeDailyExpenses(actor: DailyExpensesActor): void {
  if (
    !actor.id ||
    !canManageDailyExpenses(actor.role) ||
    (actor.status !== undefined && actor.status !== "ACTIVE")
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "You do not have access to Daily Expenses.",
      403,
    );
  }
}

export function authorizeDailyExpenseTransactionEdit(
  actor: DailyExpensesActor,
): void {
  authorizeDailyExpenses(actor);
  if (!canEditDailyExpenseTransactions(actor.role)) {
    throw new DomainError(
      "FORBIDDEN",
      "Only super administrators can edit Daily Expenses records.",
      403,
    );
  }
}

export function authorizeDailyExpenseTransactionDelete(
  actor: DailyExpensesActor,
): void {
  authorizeDailyExpenses(actor);
  if (!canDeleteDailyExpenseTransactions(actor.role)) {
    throw new DomainError(
      "FORBIDDEN",
      "Only super administrators can delete Daily Expenses records.",
      403,
    );
  }
}

export function authorizeDailyExpenseReport(actor: DailyExpensesActor): void {
  authorizeDailyExpenses(actor);
  if (!canDownloadDailyExpenseReport(actor.role)) {
    throw new DomainError(
      "FORBIDDEN",
      "Only super administrators can download Daily Expenses reports.",
      403,
    );
  }
}
