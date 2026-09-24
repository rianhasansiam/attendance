import { DomainError } from "@/lib/errors";

export type DailyExpensesActor = { id: string; role: string; status?: string };

/** Shared by navigation and every server entry point; independent of Employee. */
export function canManageDailyExpenses(role: string): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
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
