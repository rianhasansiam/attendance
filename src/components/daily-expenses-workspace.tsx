"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Archive,
  Check,
  FolderOpen,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Wallet,
} from "lucide-react";
import { Modal } from "./modal";
import { PdfDownloadButton } from "./pdf-download-button";
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
import { confirmAction } from "@/lib/client/alerts";
import { DELETED_INFO } from "@/lib/deleted-info";
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
  transactionUpdateSchema,
  type BalanceInput,
  type DailyExpenseCategoryDTO,
  type DailyExpenseTransactionDTO,
  type ExpenseInput,
  type TransactionUpdateInput,
  type TransactionDeleteInput,
} from "@/modules/daily-expenses/contracts";
import {
  useAddDailyExpenseMutation,
  useAddDailyExpensesBalanceMutation,
  useCreateDailyExpenseCategoryMutation,
  useDailyExpensesCategoriesQuery,
  useDailyExpensesSummaryQuery,
  useDailyExpensesTransactionsQuery,
  useUpdateDailyExpenseCategoryMutation,
  useUpdateDailyExpenseTransactionMutation,
  useDeleteDailyExpenseTransactionMutation,
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
  transaction?: DailyExpenseTransactionDTO;
  deleting?: boolean;
};
type Submission =
  | { type: "BALANCE_ADDED"; input: BalanceInput }
  | { type: "EXPENSE"; input: ExpenseInput }
  | { type: "UPDATE"; id: string; input: TransactionUpdateInput }
  | { type: "DELETE"; id: string; input: TransactionDeleteInput };
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

export function DailyExpensesWorkspace({
  canWrite,
  canEditTransactions,
  canDeleteTransactions,
  canDownloadReport,
}: {
  canWrite: boolean;
  canEditTransactions: boolean;
  canDeleteTransactions: boolean;
  canDownloadReport: boolean;
}) {
  const { params, update } = useUrlFilters();
  const filters: Filters = {
    from: params.get("from") || "",
    to: params.get("to") || "",
    type: params.get("type") || "",
    categoryId: params.get("categoryId") || "",
    search: params.get("search") || "",
  };
  const filterKey = JSON.stringify(filters);
  // Export every match for the applied URL filters, independent of pagination
  // and any filter edits that have not been applied yet.
  const reportQuery = new URLSearchParams(
    Object.entries(filters).filter(([, value]) => Boolean(value)),
  ).toString();
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
  const [updateTransaction] = useUpdateDailyExpenseTransactionMutation();
  const [deleteTransaction] = useDeleteDailyExpenseTransactionMutation();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const showTransactionDialog = canWrite && dialogOpen && !categoriesOpen;
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const confirmingDeletion = useRef(false);
  const submitting = useRef(false);
  const deletionPageRecovery = useRef<{ requestId?: string } | null>(null);
  const [formError, setFormError] = useState("");
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [filterError, setFilterError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmedOperation, setConfirmedOperation] = useState<
    Submission["type"] | null
  >(null);
  const activeCategories =
    categories.data?.filter((category) => !category.archived) ?? [];
  const retainedCategory = draft?.transaction?.category;
  const selectableCategories =
    retainedCategory &&
    !activeCategories.some((category) => category.id === retainedCategory.id)
      ? [
          categories.data?.find(
            (category) => category.id === retainedCategory.id,
          ) ?? retainedCategory,
          ...activeCategories,
        ]
      : activeCategories;
  const hasFilters = Object.values(filters).some(Boolean);
  const fetching =
    summary.isFetching || history.isFetching || categories.isFetching;
  const locked = busy || uncertain || confirming;
  const today = summary.data
    ? todayInTimezone(summary.data.ledger.timezone)
    : undefined;

  // A confirmed deletion can remove the only row from the last history page.
  // Wait for a fresh authoritative list before choosing its last valid page.
  useEffect(() => {
    const recovery = deletionPageRecovery.current;
    if (
      !recovery ||
      !history.data ||
      history.isFetching ||
      historyQuery.error ||
      historyQuery.requestId === recovery.requestId
    )
      return;
    const lastPage = Math.max(1, history.data.totalPages);
    if (page > lastPage) update({ page: lastPage });
    deletionPageRecovery.current = null;
  }, [
    history.data,
    history.isFetching,
    historyQuery.error,
    historyQuery.requestId,
    page,
    update,
  ]);

  // Keep the frozen payload and retry key/version for an unconfirmed write.
  // Financial data is never persisted in browser storage.
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
        "Keep this page open until this transaction change is confirmed. If the request was interrupted, use Safe retry before leaving the workspace.",
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
    if (!canWrite || locked || !summary.data) return;
    setDraft({
      type,
      amount: "",
      date: todayInTimezone(summary.data.ledger.timezone),
      note: "",
      categoryId: "",
    });
    setSubmission(null);
    setUncertain(false);
    setConflict(false);
    setErrors({});
    setFormError("");
    setMessage("");
    setDialogOpen(true);
  }

  function openSavedTransaction(transaction: DailyExpenseTransactionDTO) {
    if (!canEditTransactions || locked || !summary.data) return;
    setDraft({
      type: transaction.type,
      amount: transaction.amount,
      date: transaction.date,
      note: transaction.note ?? "",
      categoryId: transaction.category?.id ?? "",
      transaction,
    });
    setSubmission(null);
    setUncertain(false);
    setConflict(false);
    setErrors({});
    setFormError("");
    setMessage("");
    setDialogOpen(true);
  }

  async function confirmDeletion(transaction: DailyExpenseTransactionDTO) {
    if (
      !canWrite ||
      !canDeleteTransactions ||
      locked ||
      submitting.current ||
      confirmingDeletion.current ||
      !summary.data
    )
      return;
    // Capture exactly what is reviewed; a background refresh must not change
    // the version or values that this confirmation authorizes.
    const reviewed: Draft = {
      type: transaction.type,
      amount: transaction.amount,
      date: transaction.date,
      note: transaction.note ?? "",
      categoryId: transaction.category?.id ?? "",
      transaction,
      deleting: true,
    };
    const amount = formatMoney(
      transaction.amount,
      summary.data.ledger.currency,
    );
    const isExpense = transaction.type === "EXPENSE";
    confirmingDeletion.current = true;
    setConfirming(true);
    try {
      const confirmed = await confirmAction({
        title: isExpense ? "Delete Expense" : "Delete Balance",
        text: [
          `Amount: ${amount}`,
          `Transaction date: ${dateLabel(transaction.date)}`,
          ...(transaction.category
            ? [`Category: ${transaction.category.name}`]
            : []),
          `Description / note: ${transaction.note || "—"}`,
          "",
          isExpense
            ? `Deleting this expense will increase Current Balance by ${amount}.`
            : `Deleting this balance addition will reduce Current Balance and Total Balance Added by ${amount}. Current Balance may become negative.`,
          "The record will be permanently removed from the database and transaction history. This action cannot be undone; its audit history will be kept.",
        ].join("\n"),
        confirmText: "Delete record",
        danger: true,
      });
      if (!confirmed) return;
      setDraft(reviewed);
      setDialogOpen(false);
      setUncertain(false);
      setConflict(false);
      setMessage("");
      await persistSubmission(
        {
          type: "DELETE",
          id: transaction.id,
          input: { expectedVersion: transaction.version },
        },
        reviewed,
      );
    } finally {
      confirmingDeletion.current = false;
      setConfirming(false);
    }
  }

  function closeTransaction() {
    if (busy) return;
    setDialogOpen(false);
    if (!uncertain) {
      setDraft(null);
      setSubmission(null);
      if (conflict) refresh();
      setConflict(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite || !draft || submitting.current || conflict) return;
    if (
      draft.deleting
        ? !canDeleteTransactions
        : draft.transaction && !canEditTransactions
    )
      return;
    let attempt = submission;
    if (!attempt && draft.deleting && draft.transaction) {
      attempt = {
        type: "DELETE",
        id: draft.transaction.id,
        input: { expectedVersion: draft.transaction.version },
      };
      setSubmission(attempt);
    } else if (!attempt) {
      const common = {
        amount: draft.amount,
        date: draft.date,
        note: draft.note,
      };
      if (draft.type === "EXPENSE" && !draft.categoryId) {
        setErrors({ categoryId: ["Choose a category."] });
        setFormError("Check the highlighted fields before saving.");
        return;
      }
      const parsed = draft.transaction
        ? transactionUpdateSchema.safeParse({
            ...common,
            categoryId: draft.type === "EXPENSE" ? draft.categoryId : null,
            expectedVersion: draft.transaction.version,
          })
        : draft.type === "EXPENSE"
          ? expenseInputSchema.safeParse({
              ...common,
              categoryId: draft.categoryId,
              idempotencyKey: crypto.randomUUID(),
            })
          : balanceInputSchema.safeParse({
              ...common,
              idempotencyKey: crypto.randomUUID(),
            });
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
      attempt = draft.transaction
        ? {
            type: "UPDATE",
            id: draft.transaction.id,
            input: parsed.data as TransactionUpdateInput,
          }
        : draft.type === "EXPENSE"
          ? { type: "EXPENSE", input: parsed.data as ExpenseInput }
          : { type: "BALANCE_ADDED", input: parsed.data as BalanceInput };
      setSubmission(attempt);
    }
    await persistSubmission(attempt, draft);
  }

  async function persistSubmission(attempt: Submission, reviewed: Draft) {
    if (submitting.current) return;
    submitting.current = true;
    setSubmission(attempt);
    setBusy(true);
    setErrors({});
    setFormError("");
    try {
      if (attempt.type === "DELETE") {
        const result = await deleteTransaction({
          id: attempt.id,
          input: attempt.input,
        }).unwrap();
        deletionPageRecovery.current = { requestId: historyQuery.requestId };
        setMessage(
          `${reviewed.type === "EXPENSE" ? "Expense" : "Balance addition"} deleted${result.replayed ? " (the record was already deleted)" : ""}. Balances and history are being refreshed.`,
        );
      } else {
        const result =
          attempt.type === "UPDATE"
            ? await updateTransaction({
                id: attempt.id,
                input: attempt.input,
              }).unwrap()
            : attempt.type === "EXPENSE"
              ? await addExpense(attempt.input).unwrap()
              : await addBalance(attempt.input).unwrap();
        setMessage(
          `${result.transaction.type === "EXPENSE" ? "Expense" : "Balance addition"} ${attempt.type === "UPDATE" ? "updated" : "saved"}${result.replayed ? " (the earlier submission was already recorded)" : ""}. History filters are preserved; the entry may be outside the current view.`,
        );
      }
      setConfirmedOperation(attempt.type);
      setSubmission(null);
      setUncertain(false);
      setDraft(null);
      setDialogOpen(false);
      // Successful RTK invalidation refreshes the reads. A later read failure
      // cannot turn this confirmed write into a failed submission.
    } catch (error) {
      // The initial review uses SweetAlert. Recovery keeps the reviewed values
      // visible and allows retrying the original operation without reconfirming.
      if (attempt.type === "DELETE") setDialogOpen(true);
      if (isApiError(error) && error.code === "TRANSACTION_DELETED") {
        setSubmission(null);
        setUncertain(false);
        setConflict(true);
        setFormError(
          "This transaction has been deleted. Close and refresh to load the current balances and history. It cannot be edited or recreated by retrying this submission.",
        );
        return;
      }
      if (
        (attempt.type === "UPDATE" || attempt.type === "DELETE") &&
        isApiError(error) &&
        error.status === 409
      ) {
        setSubmission(null);
        setUncertain(false);
        setConflict(true);
        setFormError(
          attempt.type === "DELETE"
            ? "This transaction has changed since you opened it. Close and refresh, then review the latest record before deleting it. This attempt did not delete the newer version."
            : "This transaction has changed since you opened it. Close and refresh, then reopen the latest record to review your changes. This attempt did not overwrite the newer version.",
        );
        return;
      }
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
          attempt.type === "DELETE"
            ? "The deletion could not be confirmed. Use Safe retry to check or complete this exact deletion. The original record and version are preserved; retrying cannot delete a newer edit."
            : attempt.type === "UPDATE"
              ? "The edit could not be confirmed. Use Safe retry to check or complete this exact edit. Its values and original version are preserved so a newer edit cannot be overwritten."
              : "The save could not be confirmed. Use Safe retry to check or complete this exact transaction. Its values and retry key are preserved; no new transaction will be created for the same submission.",
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
        description={
          canWrite
            ? "Track added funds, daily expenses, and transaction history."
            : "View added funds, daily expenses, and transaction history. Only super admins can make changes."
        }
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
        <Notice notify>
          <Check size={16} />
          {message}
        </Notice>
      )}
      {message && (summaryError || historyError) && (
        <ErrorNotice
          message={
            confirmedOperation === "DELETE"
              ? "Your deletion was confirmed. The latest balances or history could not be loaded. Refresh the view to load the updated ledger."
              : "Your transaction was saved. The latest balances or history could not be loaded. Refresh the view; do not submit the saved transaction again."
          }
        />
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
      {canWrite && (
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
      )}
      {canWrite && uncertain && (
        <div className={`notice ${styles.pending}`} role="alert">
          <span>
            A transaction change is awaiting confirmation. Safely retry it
            before starting another transaction.
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
        <div className={`card-header ${styles.historyHeader}`}>
          <div>
            <h2 id="daily-history-heading">Transaction history</h2>
            <p>
              Newest transaction date first. Only super admins can edit or
              delete saved transactions.
            </p>
          </div>
          <div className={styles.historyActions}>
            {canDownloadReport && (
              <>
                <PdfDownloadButton
                  href={`/api/daily-expenses/report${reportQuery ? `?${reportQuery}` : ""}`}
                  filename="daily-expenses-report.pdf"
                  disabled={locked || !summary.data}
                />
                <p>
                  PDF includes all matching records for the applied filters.
                </p>
              </>
            )}
            {history.isFetching && (
              <span className="muted" role="status">
                Updating history…
              </span>
            )}
          </div>
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
                  {(canEditTransactions || canDeleteTransactions) && (
                    <th scope="col">Actions</th>
                  )}
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
                      {transaction.createdBy?.name ||
                        transaction.createdBy?.email ||
                        DELETED_INFO}
                    </td>
                    {(canEditTransactions || canDeleteTransactions) && (
                      <td data-label="Actions">
                        <div className="buttons">
                          {canEditTransactions && (
                            <button
                              type="button"
                              className="button small secondary"
                              disabled={
                                !summary.data || locked || history.isFetching
                              }
                              onClick={() => openSavedTransaction(transaction)}
                            >
                              <Pencil size={14} /> Edit
                            </button>
                          )}
                          {canDeleteTransactions && (
                            <button
                              type="button"
                              className="button small danger"
                              disabled={
                                !summary.data || locked || history.isFetching
                              }
                              onClick={() => void confirmDeletion(transaction)}
                            >
                              <Trash2 size={14} /> Delete
                            </button>
                          )}
                        </div>
                      </td>
                    )}
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
                : canWrite
                  ? "Your ledger is ready"
                  : "No transactions yet"
            }
            description={
              hasFilters || page > 1
                ? "Try changing the filters or returning to the first page."
                : canWrite
                  ? "Add balance or record your first expense. The balance carries forward every day."
                  : "Transactions will appear here when a super admin records them."
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

      {showTransactionDialog &&
        canDeleteTransactions &&
        draft?.deleting &&
        draft.transaction && (
          <Modal title="Deletion recovery" close={closeTransaction}>
            <form onSubmit={submit}>
              <p className={`muted ${styles.formIntro}`}>
                This is the record you confirmed for permanent deletion. Review
                the result below before retrying the same operation.
              </p>
              <dl className={styles.deleteDetails}>
                <dt>Type</dt>
                <dd>
                  {draft.type === "EXPENSE" ? "Expense" : "Balance Added"}
                </dd>
                <dt>Amount</dt>
                <dd>
                  {currency
                    ? formatMoney(draft.amount, currency)
                    : draft.amount}
                </dd>
                <dt>Transaction date</dt>
                <dd>
                  <time dateTime={draft.date}>{dateLabel(draft.date)}</time>
                </dd>
                {draft.transaction.category && (
                  <>
                    <dt>Category</dt>
                    <dd>{draft.transaction.category.name}</dd>
                  </>
                )}
                <dt>Description / note</dt>
                <dd>{draft.note || "—"}</dd>
              </dl>
              <p className={styles.deleteImpact}>
                {draft.type === "EXPENSE"
                  ? `Deleting this expense will increase Current Balance by ${currency ? formatMoney(draft.amount, currency) : draft.amount}.`
                  : `Deleting this balance addition will reduce Current Balance and Total Balance Added by ${currency ? formatMoney(draft.amount, currency) : draft.amount}. Current Balance may become negative.`}
              </p>
              <ErrorNotice message={formError} />
              {uncertain && (
                <p className={styles.retryHelp}>
                  Safe retry uses the same record and its original version. Keep
                  this page open until the deletion is confirmed.
                </p>
              )}
              <div className="form-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={closeTransaction}
                >
                  {conflict
                    ? "Close and refresh"
                    : uncertain
                      ? "Keep pending"
                      : "Cancel"}
                </button>
                {!conflict && (
                  <button
                    className="button danger"
                    type="submit"
                    disabled={busy}
                  >
                    {busy
                      ? "Confirming…"
                      : uncertain
                        ? "Safe retry"
                        : "Retry deletion"}
                  </button>
                )}
              </div>
            </form>
          </Modal>
        )}
      {showTransactionDialog && draft && !draft.deleting && (
        <Modal
          title={
            draft.transaction
              ? draft.type === "EXPENSE"
                ? "Edit Expense"
                : "Edit Balance"
              : draft.type === "EXPENSE"
                ? "Add Expense"
                : "Add Balance"
          }
          close={closeTransaction}
        >
          <form onSubmit={submit}>
            <p className={`muted ${styles.formIntro}`}>
              {draft.transaction
                ? "Update this record. Its transaction type and original recorder stay the same. Balances update after the edit is confirmed."
                : `${draft.type === "EXPENSE" ? "Record an expense, even if it takes the balance below zero." : "Record funds received into this ledger."} Only super admins can edit or delete saved transactions.`}
            </p>
            <ErrorNotice message={formError} />
            <fieldset
              className={`form-grid ${styles.fields}`}
              disabled={locked || conflict}
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
                    {selectableCategories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                        {category.archived
                          ? " (archived, current category)"
                          : ""}
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
                  {!categories.loading && selectableCategories.length === 0 && (
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
                {draft.transaction
                  ? " record version."
                  : " submission key."}{" "}
                Keep this page open until the save is confirmed.
              </p>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={closeTransaction}
              >
                {conflict
                  ? "Close and refresh"
                  : uncertain
                    ? "Keep pending"
                    : "Cancel"}
              </button>
              {!conflict && (
                <button
                  className="button"
                  type="submit"
                  disabled={
                    busy ||
                    (!uncertain &&
                      draft.type === "EXPENSE" &&
                      !selectableCategories.length)
                  }
                >
                  {busy
                    ? "Confirming…"
                    : uncertain
                      ? "Safe retry"
                      : draft.transaction
                        ? "Save changes"
                        : draft.type === "EXPENSE"
                          ? "Save expense"
                          : "Save balance addition"}
                </button>
              )}
            </div>
          </form>
        </Modal>
      )}
      {canWrite && categoriesOpen && (
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
      {message && <Notice notify>{message}</Notice>}
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
