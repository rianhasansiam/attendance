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
import { formatMoney } from "@/i18n/format-money";
import { useLocale, useTranslations } from "next-intl";
import { localizeError } from "@/i18n/errors";
import { useExpenseFeedback, type ExpenseMessage } from "./expense-feedback";
import { useFreshness } from "@/store/freshness";
import { useQueryView } from "@/store/use-query-view";
import { isApiError } from "@/store/api/errors";
import {
  balanceInputSchema,
  categoryCreateSchema,
  expenseInputSchema,
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

function dateLabel(value: string, locale: string) {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString(locale, {
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

function readError(
  error: unknown,
  subject: string,
  hasData: boolean,
  t: ReturnType<typeof useTranslations<"expenses">>,
  locale: string,
) {
  if (!error) return "";
  if (isApiError(error) && [400, 401, 403].includes(Number(error.status)))
    return localizeError(error, locale);
  return t(hasData ? "refreshFailed" : "loadFailed", { subject });
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
  const t = useTranslations("expenses");
  const locale = useLocale();
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
  const [formError, setFormError] = useExpenseFeedback();
  const [errors, setErrors] = useState<
    Record<string, (string | ExpenseMessage)[]>
  >({});
  const [filterError, setFilterError] = useExpenseFeedback();
  const [message, setMessage] = useExpenseFeedback();
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
      setFormError({ key: "keepOpen" });
    };
    window.addEventListener("beforeunload", guard);
    document.addEventListener("click", guardNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", guard);
      document.removeEventListener("click", guardNavigation, true);
    };
  }, [submission, setFormError]);

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
      locale,
    );
    const isExpense = transaction.type === "EXPENSE";
    confirmingDeletion.current = true;
    setConfirming(true);
    try {
      const confirmed = await confirmAction({
        title: isExpense ? t("deleteExpense") : t("deleteBalance"),
        text: [
          t("amountDetail", { amount }),
          t("dateDetail", { date: dateLabel(transaction.date, locale) }),
          ...(transaction.category
            ? [t("categoryDetail", { category: transaction.category.name })]
            : []),
          t("noteDetail", { note: transaction.note || "—" }),
          "",
          isExpense
            ? t("deleteExpenseImpact", { amount })
            : t("deleteBalanceImpact", { amount }),
          t("deletePermanent"),
        ].join("\n"),
        confirmText: t("deleteRecord"),
        cancelText: t("cancel"),
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
        setErrors({ categoryId: [{ key: "chooseCategory" }] });
        setFormError({ key: "checkFields" });
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
        setFormError({ key: "checkFields" });
        return;
      }
      if (
        summary.data &&
        draft.date > todayInTimezone(summary.data.ledger.timezone)
      ) {
        setErrors({
          date: [{ key: "pastDate" }],
        });
        setFormError({ key: "futureUnsupported" });
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
        setMessage({
          key: "deletedSuccess",
          values: {
            type: reviewed.type,
            replayed: result.replayed ? "yes" : "no",
          },
        });
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
        setMessage({
          key: "savedSuccess",
          values: {
            type: result.transaction.type,
            operation: attempt.type,
            replayed: result.replayed ? "yes" : "no",
          },
        });
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
        setFormError({ key: "transactionDeleted" });
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
            ? { key: "deleteConflict" }
            : { key: "editConflict" },
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
            ? { key: "deleteUnconfirmed" }
            : attempt.type === "UPDATE"
              ? { key: "editUnconfirmed" }
              : { key: "saveUnconfirmed" },
        );
      } else {
        setSubmission(null);
        setUncertain(false);
        setErrors(fieldErrors(error));
        setFormError({ error });
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
        parsed.error.issues[0]
          ? { error: new Error(parsed.error.issues[0].message) }
          : { key: "checkFilters" },
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
    t("balancesSubject"),
    !!summary.data,
    t,
    locale,
  );
  const historyError = readError(
    historyQuery.error,
    t("historySubject"),
    !!history.data,
    t,
    locale,
  );
  const categoryError = readError(
    categoriesQuery.error,
    t("categoriesSubject"),
    !!categories.data,
    t,
    locale,
  );

  return (
    <div className={styles.workspace}>
      <PageHeader
        title={t("dailyExpenses")}
        description={canWrite ? t("writeDescription") : t("readDescription")}
        action={
          <button
            type="button"
            className="button secondary"
            disabled={fetching}
            onClick={refresh}
          >
            <RefreshCw size={16} className={fetching ? "spin" : undefined} />{" "}
            {fetching ? t("refreshing") : t("refresh")}
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
              ? t("deleteRefreshFailed")
              : t("saveRefreshFailed")
          }
        />
      )}
      <ErrorNotice message={summaryError} />
      <section
        className={styles.summary}
        aria-label={t("ledgerBalances")}
        aria-busy={summary.isFetching}
      >
        <Metric
          title={t("currentBalance")}
          value={
            summary.data
              ? formatMoney(
                  summary.data.currentBalance,
                  summary.data.ledger.currency,
                  locale,
                )
              : summary.loading
                ? t("loading")
                : t("unavailable")
          }
          note={
            negative ? t("negativeBalanceDescription") : t("balanceDescription")
          }
          icon={<Wallet size={19} />}
        />
        <Metric
          title={t("totalBalanceAdded")}
          value={
            summary.data
              ? formatMoney(
                  summary.data.totalBalanceAdded,
                  summary.data.ledger.currency,
                  locale,
                )
              : summary.loading
                ? t("loading")
                : t("unavailable")
          }
          note={t("totalBalanceDescription")}
          icon={<Plus size={19} />}
        />
      </section>
      {summary.data && (
        <p className={`muted ${styles.scope}`}>
          {t("summaryScope", {
            currency: summary.data.ledger.currency,
            timezone: summary.data.ledger.timezone,
          })}
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
            <Plus size={16} />
            {t("addBalance")}
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => openTransaction("EXPENSE")}
            disabled={!summary.data || locked}
          >
            <Wallet size={16} />
            {t("addExpense")}
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => setCategoriesOpen(true)}
            disabled={busy}
          >
            <FolderOpen size={16} />
            {t("categories")}
          </button>
        </div>
      )}
      {canWrite && uncertain && (
        <div className={`notice ${styles.pending}`} role="alert">
          <span>{t("pendingTransaction")}</span>
          <button
            type="button"
            className="button small secondary"
            onClick={() => {
              setCategoriesOpen(false);
              setDialogOpen(true);
            }}
          >
            {t("reviewPending")}
          </button>
        </div>
      )}
      <section className="card" aria-labelledby="daily-history-heading">
        <div className={`card-header ${styles.historyHeader}`}>
          <div>
            <h2 id="daily-history-heading">{t("transactionHistory")}</h2>
            <p>{t("historyDescription")}</p>
          </div>
          <div className={styles.historyActions}>
            {canDownloadReport && (
              <>
                <PdfDownloadButton
                  href={`/api/daily-expenses/report${reportQuery ? `?${reportQuery}` : ""}`}
                  filename="daily-expenses-report.pdf"
                  disabled={locked || !summary.data}
                />
                <p>{t("pdfDescription")}</p>
              </>
            )}
            {history.isFetching && (
              <span className="muted" role="status">
                {t("updatingHistory")}
              </span>
            )}
          </div>
        </div>
        <form className={styles.filters} onSubmit={applyFilters}>
          <div className="field">
            <label htmlFor="daily-from">{t("fromDate")}</label>
            <input
              id="daily-from"
              type="date"
              value={filterDraft.from}
              max={filterDraft.to || today}
              onChange={(event) => changeFilter({ from: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="daily-to">{t("toDate")}</label>
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
            <label htmlFor="daily-type">{t("transactionType")}</label>
            <select
              id="daily-type"
              value={filterDraft.type}
              onChange={(event) => changeFilter({ type: event.target.value })}
            >
              <option value="">{t("allTypes")}</option>
              <option value="BALANCE_ADDED">{t("balanceAdded")}</option>
              <option value="EXPENSE">{t("expense")}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="daily-category-filter">{t("category")}</label>
            <select
              id="daily-category-filter"
              value={filterDraft.categoryId}
              onChange={(event) =>
                changeFilter({ categoryId: event.target.value })
              }
            >
              <option value="">{t("allCategories")}</option>
              {categories.data?.map((category) => (
                <option key={category.id} value={category.id}>
                  {t("categoryLabel", {
                    name: category.name,
                    archived: category.archived ? "yes" : "no",
                  })}
                </option>
              ))}
            </select>
          </div>
          <div className={`field ${styles.search}`}>
            <label htmlFor="daily-search">{t("searchNotesLabel")}</label>
            <input
              id="daily-search"
              type="search"
              maxLength={200}
              value={filterDraft.search}
              onChange={(event) => changeFilter({ search: event.target.value })}
              placeholder={t("searchNotes")}
            />
          </div>
          <div className={`buttons ${styles.filterActions}`}>
            <button className="button small" type="submit">
              {t("applyFilters")}
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
              {t("today")}
            </button>
            <button
              className="button small secondary"
              type="button"
              onClick={resetFilters}
            >
              {t("clearFilters")}
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
            aria-label={t("historyScroll")}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">{t("transactionDate")}</th>
                  <th scope="col">{t("type")}</th>
                  <th scope="col">{t("category")}</th>
                  <th scope="col">{t("note")}</th>
                  <th scope="col">{t("amount")}</th>
                  <th scope="col">{t("recordedBy")}</th>
                  {(canEditTransactions || canDeleteTransactions) && (
                    <th scope="col">{t("actions")}</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {history.data.items.map((transaction) => (
                  <tr key={transaction.id}>
                    <td data-label={t("transactionDate")}>
                      <time dateTime={transaction.date}>
                        {dateLabel(transaction.date, locale)}
                      </time>
                    </td>
                    <td data-label={t("type")}>
                      {transaction.type === "BALANCE_ADDED"
                        ? t("balanceAdded")
                        : t("expense")}
                    </td>
                    <td data-label={t("category")}>
                      {transaction.category
                        ? t("categoryLabel", {
                            name: transaction.category.name,
                            archived: transaction.category.archived
                              ? "yes"
                              : "no",
                          })
                        : "—"}
                    </td>
                    <td data-label={t("note")} className={styles.note}>
                      {transaction.note || "—"}
                    </td>
                    <td data-label={t("amount")} className={styles.amount}>
                      {transaction.type === "BALANCE_ADDED" ? "+" : "−"}
                      {currency
                        ? formatMoney(transaction.amount, currency, locale)
                        : transaction.amount}
                    </td>
                    <td data-label={t("recordedBy")}>
                      {transaction.createdBy?.name ||
                        transaction.createdBy?.email ||
                        t("deletedInfo")}
                    </td>
                    {(canEditTransactions || canDeleteTransactions) && (
                      <td data-label={t("actions")}>
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
                              <Pencil size={14} />
                              {t("edit")}
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
                              <Trash2 size={14} />
                              {t("delete")}
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
                ? t("noMatchingTransactions")
                : canWrite
                  ? t("ledgerReady")
                  : t("noTransactions")
            }
            description={
              hasFilters || page > 1
                ? t("changeFilters")
                : canWrite
                  ? t("firstExpenseDescription")
                  : t("noTransactionsDescription")
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
          <Modal title={t("deletionRecovery")} close={closeTransaction}>
            <form onSubmit={submit}>
              <p className={`muted ${styles.formIntro}`}>
                {t("deletionRecoveryDescription")}
              </p>
              <dl className={styles.deleteDetails}>
                <dt>{t("type")}</dt>
                <dd>
                  {draft.type === "EXPENSE" ? t("expense") : t("balanceAdded")}
                </dd>
                <dt>{t("amount")}</dt>
                <dd>
                  {currency
                    ? formatMoney(draft.amount, currency, locale)
                    : draft.amount}
                </dd>
                <dt>{t("transactionDate")}</dt>
                <dd>
                  <time dateTime={draft.date}>
                    {dateLabel(draft.date, locale)}
                  </time>
                </dd>
                {draft.transaction.category && (
                  <>
                    <dt>{t("category")}</dt>
                    <dd>{draft.transaction.category.name}</dd>
                  </>
                )}
                <dt>{t("note")}</dt>
                <dd>{draft.note || "—"}</dd>
              </dl>
              <p className={styles.deleteImpact}>
                {draft.type === "EXPENSE"
                  ? t("deleteExpenseImpact", {
                      amount: currency
                        ? formatMoney(draft.amount, currency, locale)
                        : draft.amount,
                    })
                  : t("deleteBalanceImpact", {
                      amount: currency
                        ? formatMoney(draft.amount, currency, locale)
                        : draft.amount,
                    })}
              </p>
              <ErrorNotice message={formError} />
              {uncertain && (
                <p className={styles.retryHelp}>{t("safeDeleteHelp")}</p>
              )}
              <div className="form-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={closeTransaction}
                >
                  {conflict
                    ? t("closeRefresh")
                    : uncertain
                      ? t("keepPending")
                      : t("cancel")}
                </button>
                {!conflict && (
                  <button
                    className="button danger"
                    type="submit"
                    disabled={busy}
                  >
                    {busy
                      ? t("confirming")
                      : uncertain
                        ? t("safeRetry")
                        : t("retryDelete")}
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
                ? t("editExpense")
                : t("editBalance")
              : draft.type === "EXPENSE"
                ? t("addExpense")
                : t("addBalance")
          }
          close={closeTransaction}
        >
          <form onSubmit={submit}>
            <p className={`muted ${styles.formIntro}`}>
              {draft.transaction
                ? t("editDescription")
                : t("newTransactionDescription", { type: draft.type })}
            </p>
            <ErrorNotice message={formError} />
            <fieldset
              className={`form-grid ${styles.fields}`}
              disabled={locked || conflict}
            >
              <div className="field">
                <label htmlFor="daily-amount">
                  {t("amountCurrency", { currency: currency ?? "BDT" })}
                </label>
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
                <small id="daily-amount-help">{t("amountHelp")}</small>
                {errors.amount && (
                  <span id="daily-amount-error" className={styles.fieldError}>
                    {errors.amount
                      .map((message) =>
                        typeof message === "string"
                          ? localizeError(new Error(message), locale)
                          : t(message.key, message.values),
                      )
                      .join(" ")}
                  </span>
                )}
              </div>
              <div className="field">
                <label htmlFor="daily-date">{t("transactionDate")}</label>
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
                  {t("workspaceTimezone", {
                    timezone: summary.data?.ledger.timezone ?? "",
                  })}
                </small>
                {errors.date && (
                  <span id="daily-date-error" className={styles.fieldError}>
                    {errors.date
                      .map((message) =>
                        typeof message === "string"
                          ? localizeError(new Error(message), locale)
                          : t(message.key, message.values),
                      )
                      .join(" ")}
                  </span>
                )}
              </div>
              {draft.type === "EXPENSE" && (
                <div className="field full">
                  <label htmlFor="daily-expense-category">
                    {t("category")}
                  </label>
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
                    <option value="">{t("chooseActiveCategory")}</option>
                    {selectableCategories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {t("currentCategoryLabel", {
                          name: category.name,
                          archived: category.archived ? "yes" : "no",
                        })}
                      </option>
                    ))}
                  </select>
                  {errors.categoryId && (
                    <span
                      id="daily-category-error"
                      className={styles.fieldError}
                    >
                      {errors.categoryId
                        .map((message) =>
                          typeof message === "string"
                            ? localizeError(new Error(message), locale)
                            : t(message.key, message.values),
                        )
                        .join(" ")}
                    </span>
                  )}
                  {categoryError && <ErrorNotice message={categoryError} />}
                  {!categories.loading && selectableCategories.length === 0 && (
                    <p>{t("noActiveCategories")}</p>
                  )}
                  <button
                    type="button"
                    className="button small secondary"
                    onClick={() => setCategoriesOpen(true)}
                  >
                    {t("manageCategories")}
                  </button>
                </div>
              )}
              <div className="field full">
                <label htmlFor="daily-note">
                  {draft.type === "EXPENSE"
                    ? t("optionalNote")
                    : t("optionalSource")}
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
                    {errors.note
                      .map((message) =>
                        typeof message === "string"
                          ? localizeError(new Error(message), locale)
                          : t(message.key, message.values),
                      )
                      .join(" ")}
                  </span>
                )}
              </div>
            </fieldset>
            {uncertain && (
              <p className={styles.retryHelp}>
                {t("safeSaveHelp", {
                  operation: draft.transaction ? "edit" : "create",
                })}
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
                  ? t("closeRefresh")
                  : uncertain
                    ? t("keepPending")
                    : t("cancel")}
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
                    ? t("confirming")
                    : uncertain
                      ? t("safeRetry")
                      : draft.transaction
                        ? t("saveChanges")
                        : draft.type === "EXPENSE"
                          ? t("saveExpense")
                          : t("saveBalance")}
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
  const t = useTranslations("expenses");
  const locale = useLocale();
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
  const [error, setError] = useExpenseFeedback();
  const [message, setMessage] = useExpenseFeedback();

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const parsed = categoryCreateSchema.safeParse({
      name: editing ? editing.name : name,
    });
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]
          ? { error: new Error(parsed.error.issues[0].message) }
          : { key: "enterCategory" },
      );
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
      setMessage(
        editing ? { key: "categoryRenamed" } : { key: "categoryCreated" },
      );
      if (!editing) {
        onCreated(category);
        setName("");
      }
      setEditing(null);
    } catch (error) {
      setError({ error });
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
          ? { key: "categoryRestored" }
          : { key: "categoryArchived" },
      );
    } catch (error) {
      setError({ error });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const refreshError = readError(
    query.error,
    t("categoriesSubject"),
    !!categories.data,
    t,
    locale,
  );
  return (
    <Modal
      title={t("categories")}
      close={() => {
        if (!busy) close();
      }}
    >
      <p className={`muted ${styles.formIntro}`}>{t("categoryDescription")}</p>
      {message && <Notice notify>{message}</Notice>}
      {message && refreshError && (
        <ErrorNotice message={t("categoryRefreshFailed")} />
      )}
      <ErrorNotice message={error || refreshError} />
      <form onSubmit={save} className={styles.categoryForm}>
        <div className="field">
          <label htmlFor="daily-category-name">
            {editing ? t("renameCategory") : t("newCategory")}
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
          {busy ? t("saving") : editing ? t("saveName") : t("createCategory")}
        </button>
        {editing && (
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={() => setEditing(null)}
          >
            {t("cancelRename")}
          </button>
        )}
      </form>
      <div className={styles.categoryHeading}>
        <h3>{t("allCategories")}</h3>
        <button
          type="button"
          className="button small secondary"
          disabled={categories.isFetching}
          onClick={() => void categories.refresh()}
        >
          <RefreshCw size={14} />
          {t("refresh")}
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
                  {category.archived ? t("archived") : t("active")}
                </span>
              </div>
              <div className={`buttons ${styles.categoryButtons}`}>
                <button
                  type="button"
                  className="button small secondary"
                  aria-label={t("renameCategoryLabel", { name: category.name })}
                  disabled={busy}
                  onClick={() => {
                    setEditing({ id: category.id, name: category.name });
                    setError("");
                    document.getElementById("daily-category-name")?.focus();
                  }}
                >
                  {t("rename")}
                </button>
                <button
                  type="button"
                  className="button small secondary"
                  aria-label={t("archiveCategoryLabel", {
                    name: category.name,
                    operation: category.archived ? "restore" : "archive",
                  })}
                  disabled={busy}
                  onClick={() => void archive(category)}
                >
                  <Archive size={13} />
                  {category.archived ? t("restore") : t("archive")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : categories.data ? (
        <Empty
          title={t("noCategories")}
          description={t("noCategoriesDescription")}
        />
      ) : null}
      <div className="form-actions">
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={close}
        >
          {returningToExpense ? t("backToExpense") : t("done")}
        </button>
      </div>
    </Modal>
  );
}
