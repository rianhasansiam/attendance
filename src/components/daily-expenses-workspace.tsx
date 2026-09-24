"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Archive,
  Check,
  FolderOpen,
  Plus,
  RefreshCw,
  Wallet,
} from "lucide-react";
import { Modal } from "./modal";
import {
  Empty,
  ErrorNotice,
  Loading,
  Metric,
  Notice,
  PageHeader,
  Pagination,
} from "./ui";
import { pageFromSearch, useUrlFilters } from "@/lib/client/use-url-filters";
import { useFreshness } from "@/store/freshness";
import { useQueryView } from "@/store/use-query-view";
import { errorMessage, isApiError } from "@/store/api/errors";
import {
  balanceInputSchema,
  categoryCreateSchema,
  expenseInputSchema,
  formatMoney,
  historyQuerySchema,
  todayInTimezone,
  type BalanceInput,
  type DailyExpenseCategoryDTO,
  type DailyExpenseTransactionDTO,
  type ExpenseInput,
} from "@/modules/daily-expenses/contracts";
import {
  useAddDailyExpenseMutation,
  useAddDailyExpensesBalanceMutation,
  useCreateDailyExpenseCategoryMutation,
  useDailyExpensesCategoriesQuery,
  useDailyExpensesSummaryQuery,
  useDailyExpensesTransactionsQuery,
  useUpdateDailyExpenseCategoryMutation,
  type DailyExpensesHistoryArgs,
} from "@/store/features/daily-expenses/api";
import styles from "./daily-expenses-workspace.module.css";

const PAGE_SIZE = 25;
type TransactionType = DailyExpenseTransactionDTO["type"];
type Draft = {
  type: TransactionType;
  amount: string;
  date: string;
  note: string;
  categoryId: string;
};
type Submission =
  | { type: "BALANCE_ADDED"; input: BalanceInput }
  | { type: "EXPENSE"; input: ExpenseInput };
type Filters = {
  from: string;
  to: string;
  type: string;
  categoryId: string;
  search: string;
};

function dateLabel(value: string) {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function requestMayHaveCommitted(error: unknown) {
  return (
    !isApiError(error) ||
    typeof error.status !== "number" ||
    error.status >= 500
  );
}

function readError(error: unknown, subject: string, hasData: boolean) {
  if (!error) return "";
  if (isApiError(error) && [400, 401, 403].includes(Number(error.status)))
    return error.message;
  return `${hasData ? `Could not refresh ${subject}. Previously loaded data is shown.` : `Could not load ${subject}.`} Use Refresh to try loading it again.`;
}

function fieldErrors(error: unknown) {
  return isApiError(error) ? (error.fields ?? error.fieldErrors ?? {}) : {};
}

export function DailyExpensesWorkspace() {
  const { params, update } = useUrlFilters();
  const filters: Filters = {
    from: params.get("from") || "",
    to: params.get("to") || "",
    type: params.get("type") || "",
    categoryId: params.get("categoryId") || "",
    search: params.get("search") || "",
  };
  const filterKey = JSON.stringify(filters);
  const [filterEdit, setFilterEdit] = useState({
    key: filterKey,
    values: filters,
  });
  const filterDraft =
    filterEdit.key === filterKey ? filterEdit.values : filters;
  const changeFilter = (patch: Partial<Filters>) =>
    setFilterEdit({ key: filterKey, values: { ...filterDraft, ...patch } });
  const page = pageFromSearch(params.get("page"));
  const historyArgs: DailyExpensesHistoryArgs = {
    page,
    pageSize: PAGE_SIZE,
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
    ...(filters.type ? { type: filters.type as TransactionType } : {}),
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(filters.search ? { search: filters.search } : {}),
  };
  const freshness = useFreshness();
  const summaryQuery = useDailyExpensesSummaryQuery(undefined, freshness);
  const historyQuery = useDailyExpensesTransactionsQuery(
    historyArgs,
    freshness,
  );
  const categoriesQuery = useDailyExpensesCategoriesQuery(undefined, freshness);
  const summary = useQueryView(summaryQuery);
  const history = useQueryView(historyQuery);
  const categories = useQueryView(categoriesQuery);
  const [addBalance] = useAddDailyExpensesBalanceMutation();
  const [addExpense] = useAddDailyExpenseMutation();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [formError, setFormError] = useState("");
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [filterError, setFilterError] = useState("");
  const [message, setMessage] = useState("");
  const activeCategories =
    categories.data?.filter((category) => !category.archived) ?? [];
  const hasFilters = Object.values(filters).some(Boolean);
  const fetching =
    summary.isFetching || history.isFetching || categories.isFetching;
  const locked = busy || uncertain;
  const today = summary.data
    ? todayInTimezone(summary.data.ledger.timezone)
    : undefined;

  // A browser reload must not casually discard the key for an unconfirmed write.
  // The key and payload stay local; financial data is never persisted in browser storage.
  useEffect(() => {
    if (!submission) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const guardNavigation = (event: MouseEvent) => {
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.hasAttribute("download") ||
        (anchor.target && anchor.target !== "_self")
      )
        return;
      const destination = new URL(anchor.href, window.location.href);
      if (
        destination.origin !== window.location.origin ||
        destination.pathname === window.location.pathname
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setCategoriesOpen(false);
      setDialogOpen(true);
      setFormError(
        "Keep this page open until this transaction is confirmed. If its save was interrupted, use Safe retry before leaving the workspace.",
      );
    };
    window.addEventListener("beforeunload", guard);
    document.addEventListener("click", guardNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", guard);
      document.removeEventListener("click", guardNavigation, true);
    };
  }, [submission]);

  function openTransaction(type: TransactionType) {
    if (locked || !summary.data) return;
    setDraft({
      type,
      amount: "",
      date: todayInTimezone(summary.data.ledger.timezone),
      note: "",
      categoryId: "",
    });
    setSubmission(null);
    setUncertain(false);
    setErrors({});
    setFormError("");
    setMessage("");
    setDialogOpen(true);
  }

  function closeTransaction() {
    if (busy) return;
    setDialogOpen(false);
    if (!uncertain) {
      setDraft(null);
      setSubmission(null);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || submitting.current) return;
    let attempt = submission;
    if (!attempt) {
      const common = {
        amount: draft.amount,
        date: draft.date,
        note: draft.note,
        idempotencyKey: crypto.randomUUID(),
      };
      const parsed =
        draft.type === "EXPENSE"
          ? expenseInputSchema.safeParse({
              ...common,
              categoryId: draft.categoryId,
            })
          : balanceInputSchema.safeParse(common);
      if (!parsed.success) {
        setErrors(parsed.error.flatten().fieldErrors);
        setFormError("Check the highlighted fields before saving.");
        return;
      }
      if (
        summary.data &&
        draft.date > todayInTimezone(summary.data.ledger.timezone)
      ) {
        setErrors({
          date: ["Choose today or a past date in the workspace timezone."],
        });
        setFormError("Future transactions are not supported.");
        return;
      }
      attempt =
        draft.type === "EXPENSE"
          ? { type: "EXPENSE", input: parsed.data as ExpenseInput }
          : { type: "BALANCE_ADDED", input: parsed.data as BalanceInput };
      setSubmission(attempt);
    }
    submitting.current = true;
    setBusy(true);
    setErrors({});
    setFormError("");
    try {
      const result =
        attempt.type === "EXPENSE"
          ? await addExpense(attempt.input).unwrap()
          : await addBalance(attempt.input).unwrap();
      setMessage(
        `${result.transaction.type === "EXPENSE" ? "Expense" : "Balance addition"} saved${result.replayed ? " (the earlier submission was already recorded)" : ""}. History filters are preserved; the entry may be outside the current view.`,
      );
      setSubmission(null);
      setUncertain(false);
      setDraft(null);
      setDialogOpen(false);
      // Successful RTK invalidation refreshes the reads. A later read failure
      // cannot turn this confirmed write into a failed submission.
    } catch (error) {
      // Only business rejections reached after the server's replay check can
      // resolve an earlier uncertain attempt. A rate-limit or authorization
      // rejection alone says nothing about that earlier write.
      const resolvedRejection =
        isApiError(error) &&
        error.status === 400 &&
        ["INVALID_CATEGORY", "FUTURE_DATE"].includes(error.code);
      if (requestMayHaveCommitted(error) || (uncertain && !resolvedRejection)) {
        setUncertain(true);
        setFormError(
          "The save could not be confirmed. Use Safe retry to check or complete this exact transaction. Its values and retry key are preserved; no new transaction will be created for the same submission.",
        );
      } else {
        setSubmission(null);
        setUncertain(false);
        setErrors(fieldErrors(error));
        setFormError(errorMessage(error));
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = historyQuerySchema.safeParse({
      ...Object.fromEntries(
        Object.entries(filterDraft).filter(([, value]) => value),
      ),
      page: 1,
      pageSize: PAGE_SIZE,
    });
    if (!parsed.success) {
      setFilterError(
        parsed.error.issues[0]?.message ?? "Check the history filters.",
      );
      return;
    }
    setFilterError("");
    update({ ...filterDraft, page: 1 });
  }

  function resetFilters() {
    const empty: Filters = {
      from: "",
      to: "",
      type: "",
      categoryId: "",
      search: "",
    };
    setFilterEdit({ key: JSON.stringify(empty), values: empty });
    setFilterError("");
    update({ ...empty, page: null });
  }

  function refresh() {
    // Manual refresh is the only explicit refetch; mutations use tag invalidation.
    void summary.refresh();
    void history.refresh();
    void categories.refresh();
  }

  const negative = summary.data?.currentBalance.startsWith("-") ?? false;
  const currency = summary.data?.ledger.currency;
  const summaryError = readError(
    summaryQuery.error,
    "the all-time balances",
    !!summary.data,
  );
  const historyError = readError(
    historyQuery.error,
    "transaction history",
    !!history.data,
  );
  const categoryError = readError(
    categoriesQuery.error,
    "categories",
    !!categories.data,
  );

  return (
    <div className={styles.workspace}>
      <PageHeader
        title="Daily Expenses"
        description="Track added funds, daily expenses, and transaction history."
        action={
          <button
            type="button"
            className="button secondary"
            disabled={fetching}
            onClick={refresh}
          >
            <RefreshCw size={16} className={fetching ? "spin" : undefined} />{" "}
            {fetching ? "Refreshing…" : "Refresh"}
          </button>
        }
      />
      {message && (
        <Notice>
          <Check size={16} />
          {message}
        </Notice>
      )}
      {message && (summaryError || historyError) && (
        <ErrorNotice message="Your transaction was saved. The latest balances or history could not be loaded. Refresh the view; do not submit the saved transaction again." />
      )}
      <ErrorNotice message={summaryError} />
      <section
        className={styles.summary}
        aria-label="All-time ledger balances"
        aria-busy={summary.isFetching}
      >
        <Metric
          title="Current Balance"
          value={
            summary.data
              ? formatMoney(
                  summary.data.currentBalance,
                  summary.data.ledger.currency,
                )
              : summary.loading
                ? "Loading…"
                : "Unavailable"
          }
          note={
            negative
              ? "Negative balance · all funds added minus all expenses, all time."
              : "All funds added minus all expenses, all time."
          }
          icon={<Wallet size={19} />}
        />
        <Metric
          title="Total Balance Added"
          value={
            summary.data
              ? formatMoney(
                  summary.data.totalBalanceAdded,
                  summary.data.ledger.currency,
                )
              : summary.loading
                ? "Loading…"
                : "Unavailable"
          }
          note="Cumulative funds added, all time. Expenses do not reduce this total."
          icon={<Plus size={19} />}
        />
      </section>
      {summary.data && (
        <p className={`muted ${styles.scope}`}>
          {summary.data.ledger.currency} · {summary.data.ledger.timezone} ·
          History filters do not change these totals.
        </p>
      )}
      <div className={`buttons ${styles.actions}`}>
        <button
          type="button"
          className="button"
          onClick={() => openTransaction("BALANCE_ADDED")}
          disabled={!summary.data || locked}
        >
          <Plus size={16} /> Add Balance
        </button>
        <button
          type="button"
          className="button secondary"
          onClick={() => openTransaction("EXPENSE")}
          disabled={!summary.data || locked}
        >
          <Wallet size={16} /> Add Expense
        </button>
        <button
          type="button"
          className="button secondary"
          onClick={() => setCategoriesOpen(true)}
          disabled={busy}
        >
          <FolderOpen size={16} /> Categories
        </button>
      </div>
      {uncertain && (
        <div className={`notice ${styles.pending}`} role="alert">
          <span>
            A transaction is awaiting confirmation. Safely retry it before
            starting another transaction.
          </span>
          <button
            type="button"
            className="button small secondary"
            onClick={() => {
              setCategoriesOpen(false);
              setDialogOpen(true);
            }}
          >
            Review pending transaction
          </button>
        </div>
      )}
      <section className="card" aria-labelledby="daily-history-heading">
        <div className="card-header">
          <div>
            <h2 id="daily-history-heading">Transaction history</h2>
            <p>
              Newest transaction date first. Posted transactions are permanent.
            </p>
          </div>
          {history.isFetching && (
            <span className="muted" role="status">
              Updating history…
            </span>
          )}
        </div>
        <form className={styles.filters} onSubmit={applyFilters}>
          <div className="field">
            <label htmlFor="daily-from">From date</label>
            <input
              id="daily-from"
              type="date"
              value={filterDraft.from}
              max={filterDraft.to || today}
              onChange={(event) => changeFilter({ from: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="daily-to">To date</label>
            <input
              id="daily-to"
              type="date"
              value={filterDraft.to}
              min={filterDraft.from || undefined}
              max={today}
              onChange={(event) => changeFilter({ to: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="daily-type">Transaction type</label>
            <select
              id="daily-type"
              value={filterDraft.type}
              onChange={(event) => changeFilter({ type: event.target.value })}
            >
              <option value="">All types</option>
              <option value="BALANCE_ADDED">Balance Added</option>
              <option value="EXPENSE">Expense</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="daily-category-filter">Category</label>
            <select
              id="daily-category-filter"
              value={filterDraft.categoryId}
              onChange={(event) =>
                changeFilter({ categoryId: event.target.value })
              }
            >
              <option value="">All categories</option>
              {categories.data?.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                  {category.archived ? " (archived)" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className={`field ${styles.search}`}>
            <label htmlFor="daily-search">Search descriptions and notes</label>
            <input
              id="daily-search"
              type="search"
              maxLength={200}
              value={filterDraft.search}
              onChange={(event) => changeFilter({ search: event.target.value })}
              placeholder="Search transaction notes"
            />
          </div>
          <div className={`buttons ${styles.filterActions}`}>
            <button className="button small" type="submit">
              Apply filters
            </button>
            <button
              className="button small secondary"
              type="button"
              disabled={!summary.data}
              onClick={() => {
                if (summary.data) {
                  setFilterError("");
                  update({
                    from: todayInTimezone(summary.data.ledger.timezone),
                    to: todayInTimezone(summary.data.ledger.timezone),
                    page: 1,
                  });
                }
              }}
            >
              Today
            </button>
            <button
              className="button small secondary"
              type="button"
              onClick={resetFilters}
            >
              Clear filters
            </button>
          </div>
          {(filterError || categoryError) && (
            <div className={styles.full}>
              <ErrorNotice message={filterError || categoryError} />
            </div>
          )}
        </form>
        {historyError && (
          <div className={styles.readError}>
            <ErrorNotice message={historyError} />
          </div>
        )}
        {history.loading ? (
          <Loading />
        ) : history.data && history.data.items.length > 0 ? (
          <div
            className={`table-scroll ${styles.historyTable}`}
            tabIndex={0}
            aria-label="Transaction history, scroll for more columns"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Transaction date</th>
                  <th scope="col">Type</th>
                  <th scope="col">Category</th>
                  <th scope="col">Description / note</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Recorded by</th>
                </tr>
              </thead>
              <tbody>
                {history.data.items.map((transaction) => (
                  <tr key={transaction.id}>
                    <td data-label="Transaction date">
                      <time dateTime={transaction.date}>
                        {dateLabel(transaction.date)}
                      </time>
                    </td>
                    <td data-label="Type">
                      {transaction.type === "BALANCE_ADDED"
                        ? "Balance Added"
                        : "Expense"}
                    </td>
                    <td data-label="Category">
                      {transaction.category
                        ? `${transaction.category.name}${transaction.category.archived ? " (archived)" : ""}`
                        : "—"}
                    </td>
                    <td data-label="Description / note" className={styles.note}>
                      {transaction.note || "—"}
                    </td>
                    <td data-label="Amount" className={styles.amount}>
                      {transaction.type === "BALANCE_ADDED" ? "+" : "−"}
                      {currency
                        ? formatMoney(transaction.amount, currency)
                        : transaction.amount}
                    </td>
                    <td data-label="Recorded by">
                      {transaction.createdBy.name ||
                        transaction.createdBy.email}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : history.data ? (
          <Empty
            title={
              hasFilters || page > 1
                ? "No matching transactions"
                : "Your ledger is ready"
            }
            description={
              hasFilters || page > 1
                ? "Try changing the filters or returning to the first page."
                : "Add balance or record your first expense. The balance carries forward every day."
            }
          />
        ) : null}
        {history.data && (
          <Pagination
            page={history.data.page}
            pageSize={history.data.pageSize}
            total={history.data.total}
            loading={history.isFetching}
            onPage={(next) => update({ page: next })}
          />
        )}
      </section>

      {dialogOpen && draft && !categoriesOpen && (
        <Modal
          title={draft.type === "EXPENSE" ? "Add Expense" : "Add Balance"}
          close={closeTransaction}
        >
          <form onSubmit={submit}>
            <p className={`muted ${styles.formIntro}`}>
              {draft.type === "EXPENSE"
                ? "Record an expense, even if it takes the balance below zero."
                : "Record funds received into this ledger."}{" "}
              Transactions cannot be edited or deleted after saving.
            </p>
            <ErrorNotice message={formError} />
            <fieldset
              className={`form-grid ${styles.fields}`}
              disabled={locked}
            >
              <div className="field">
                <label htmlFor="daily-amount">Amount ({currency})</label>
                <input
                  id="daily-amount"
                  name="amount"
                  type="text"
                  inputMode="decimal"
                  required
                  maxLength={64}
                  placeholder="0.00"
                  value={draft.amount}
                  aria-invalid={!!errors.amount}
                  aria-describedby={
                    errors.amount ? "daily-amount-error" : "daily-amount-help"
                  }
                  onChange={(event) =>
                    setDraft({ ...draft, amount: event.target.value })
                  }
                />
                <small id="daily-amount-help">
                  Positive amount, up to two decimal places. No commas.
                </small>
                {errors.amount && (
                  <span id="daily-amount-error" className={styles.fieldError}>
                    {errors.amount.join(" ")}
                  </span>
                )}
              </div>
              <div className="field">
                <label htmlFor="daily-date">Transaction date</label>
                <input
                  id="daily-date"
                  name="date"
                  type="date"
                  required
                  max={today}
                  value={draft.date}
                  aria-invalid={!!errors.date}
                  aria-describedby={
                    errors.date
                      ? "daily-date-help daily-date-error"
                      : "daily-date-help"
                  }
                  onChange={(event) =>
                    setDraft({ ...draft, date: event.target.value })
                  }
                />
                <small id="daily-date-help">
                  Workspace timezone: {summary.data?.ledger.timezone}
                </small>
                {errors.date && (
                  <span id="daily-date-error" className={styles.fieldError}>
                    {errors.date.join(" ")}
                  </span>
                )}
              </div>
              {draft.type === "EXPENSE" && (
                <div className="field full">
                  <label htmlFor="daily-expense-category">Category</label>
                  <select
                    id="daily-expense-category"
                    name="categoryId"
                    required
                    value={draft.categoryId}
                    aria-invalid={!!errors.categoryId}
                    aria-describedby={
                      errors.categoryId ? "daily-category-error" : undefined
                    }
                    onChange={(event) =>
                      setDraft({ ...draft, categoryId: event.target.value })
                    }
                  >
                    <option value="">Choose an active category</option>
                    {activeCategories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                  {errors.categoryId && (
                    <span
                      id="daily-category-error"
                      className={styles.fieldError}
                    >
                      {errors.categoryId.join(" ")}
                    </span>
                  )}
                  {categoryError && <ErrorNotice message={categoryError} />}
                  {!categories.loading && activeCategories.length === 0 && (
                    <p>
                      No active categories are available. Create or restore a
                      category to record an expense.
                    </p>
                  )}
                  <button
                    type="button"
                    className="button small secondary"
                    onClick={() => setCategoriesOpen(true)}
                  >
                    Create or manage categories
                  </button>
                </div>
              )}
              <div className="field full">
                <label htmlFor="daily-note">
                  {draft.type === "EXPENSE"
                    ? "Description / note (optional)"
                    : "Note / source description (optional)"}
                </label>
                <textarea
                  id="daily-note"
                  name="note"
                  maxLength={1000}
                  value={draft.note}
                  aria-invalid={!!errors.note}
                  aria-describedby={
                    errors.note ? "daily-note-error" : undefined
                  }
                  onChange={(event) =>
                    setDraft({ ...draft, note: event.target.value })
                  }
                />
                {errors.note && (
                  <span id="daily-note-error" className={styles.fieldError}>
                    {errors.note.join(" ")}
                  </span>
                )}
              </div>
            </fieldset>
            {uncertain && (
              <p className={styles.retryHelp}>
                Safe retry uses the original amount, date, category, note, and
                submission key. Keep this page open until the save is confirmed.
              </p>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={closeTransaction}
              >
                {uncertain ? "Keep pending" : "Cancel"}
              </button>
              <button
                className="button"
                type="submit"
                disabled={
                  busy ||
                  (!uncertain &&
                    draft.type === "EXPENSE" &&
                    !activeCategories.length)
                }
              >
                {busy
                  ? "Confirming…"
                  : uncertain
                    ? "Safe retry"
                    : draft.type === "EXPENSE"
                      ? "Save expense"
                      : "Save balance addition"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {categoriesOpen && (
        <CategoryDialog
          close={() => setCategoriesOpen(false)}
          onCreated={(category) => {
            if (draft?.type === "EXPENSE" && !locked)
              setDraft({ ...draft, categoryId: category.id });
          }}
          returningToExpense={dialogOpen && draft?.type === "EXPENSE"}
        />
      )}
    </div>
  );
}

function CategoryDialog({
  close,
  onCreated,
  returningToExpense,
}: {
  close: () => void;
  onCreated: (category: DailyExpenseCategoryDTO) => void;
  returningToExpense: boolean;
}) {
  const query = useDailyExpensesCategoriesQuery(undefined, useFreshness());
  const categories = useQueryView(query);
  const [createCategory] = useCreateDailyExpenseCategoryMutation();
  const [updateCategory] = useUpdateDailyExpenseCategoryMutation();
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const parsed = categoryCreateSchema.safeParse({
      name: editing ? editing.name : name,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Enter a category name.");
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const category = editing
        ? await updateCategory({ id: editing.id, input: parsed.data }).unwrap()
        : await createCategory(parsed.data).unwrap();
      setMessage(editing ? "Category renamed." : "Category created.");
      if (!editing) {
        onCreated(category);
        setName("");
      }
      setEditing(null);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function archive(category: DailyExpenseCategoryDTO) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await updateCategory({
        id: category.id,
        input: { archived: !category.archived },
      }).unwrap();
      setMessage(
        category.archived
          ? "Category restored."
          : "Category archived. Its transaction history is preserved.",
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const refreshError = readError(query.error, "categories", !!categories.data);
  return (
    <Modal
      title="Categories"
      close={() => {
        if (!busy) close();
      }}
    >
      <p className={`muted ${styles.formIntro}`}>
        Archived categories remain in history and filters. Only active
        categories can be used for new expenses.
      </p>
      {message && <Notice>{message}</Notice>}
      {message && refreshError && (
        <ErrorNotice message="Your category change was saved. Refresh the list to load the latest categories." />
      )}
      <ErrorNotice message={error || refreshError} />
      <form onSubmit={save} className={styles.categoryForm}>
        <div className="field">
          <label htmlFor="daily-category-name">
            {editing ? "Rename category" : "New category"}
          </label>
          <input
            id="daily-category-name"
            type="text"
            required
            maxLength={80}
            disabled={busy}
            value={editing ? editing.name : name}
            onChange={(event) =>
              editing
                ? setEditing({ ...editing, name: event.target.value })
                : setName(event.target.value)
            }
          />
        </div>
        <button className="button" type="submit" disabled={busy}>
          {busy ? "Saving…" : editing ? "Save name" : "Create category"}
        </button>
        {editing && (
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={() => setEditing(null)}
          >
            Cancel rename
          </button>
        )}
      </form>
      <div className={styles.categoryHeading}>
        <h3>All categories</h3>
        <button
          type="button"
          className="button small secondary"
          disabled={categories.isFetching}
          onClick={() => void categories.refresh()}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      {categories.loading ? (
        <Loading />
      ) : categories.data?.length ? (
        <ul className={styles.categories}>
          {categories.data.map((category) => (
            <li key={category.id}>
              <div className={styles.categoryName}>
                <strong>{category.name}</strong>
                <span className="muted">
                  {category.archived ? "Archived" : "Active"}
                </span>
              </div>
              <div className={`buttons ${styles.categoryButtons}`}>
                <button
                  type="button"
                  className="button small secondary"
                  aria-label={`Rename ${category.name}`}
                  disabled={busy}
                  onClick={() => {
                    setEditing({ id: category.id, name: category.name });
                    setError("");
                    document.getElementById("daily-category-name")?.focus();
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="button small secondary"
                  aria-label={`${category.archived ? "Restore" : "Archive"} ${category.name}`}
                  disabled={busy}
                  onClick={() => void archive(category)}
                >
                  <Archive size={13} />
                  {category.archived ? "Restore" : "Archive"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : categories.data ? (
        <Empty
          title="No categories yet"
          description="Create your first category above, then record an expense."
        />
      ) : null}
      <div className="form-actions">
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={close}
        >
          {returningToExpense ? "Back to expense" : "Done"}
        </button>
      </div>
    </Modal>
  );
}
