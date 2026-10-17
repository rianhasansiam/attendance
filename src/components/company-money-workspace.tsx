"use client";

import { useRef, useState, type FormEvent } from "react";
import { Check, Minus, Pencil, Plus, Trash2, Wallet } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { formatInTimeZone } from "date-fns-tz";
import {
  Empty,
  ErrorNotice,
  Loading,
  Notice,
  PageHeader,
  Pagination,
  Refresh,
  Table,
  type DataRow,
} from "./ui";
import { formatMoney } from "@/i18n/format-money";
import { useErrorMessage } from "@/i18n/errors";
import { isAmbiguousWrite } from "@/lib/client/attendance-ceremony";
import { confirmAction } from "@/lib/client/alerts";
import type {
  CompanyMoneyInput,
  CompanyMoneyTransactionRecord,
  CompanyMoneyUpdateInput,
  CompanyMoneyDeleteInput,
} from "@/modules/company-money/contracts";
import { useFreshness } from "@/store/freshness";
import { useQueryView } from "@/store/use-query-view";
import {
  useCompanyMoneyQuery,
  useUpdateCompanyMoneyMutation,
  useEditCompanyMoneyTransactionMutation,
  useDeleteCompanyMoneyTransactionMutation,
} from "@/store/features/company-money/api";
import styles from "./company-money-workspace.module.css";

const PAGE_SIZE = 20;

type Draft = {
  type: CompanyMoneyInput["type"];
  date: string;
  amount: string;
  note: string;
};
type PendingMutation =
  | { kind: "create"; input: CompanyMoneyInput }
  | { kind: "edit"; id: string; input: CompanyMoneyUpdateInput }
  | {
      kind: "delete";
      id: string;
      input: CompanyMoneyDeleteInput;
      page: number;
      lastOnPage: boolean;
    };
type CompletedMessage =
  | "balanceAdded"
  | "balanceRemoved"
  | "transactionUpdated"
  | "transactionDeleted";

export function CompanyMoneyWorkspace({ canManage }: { canManage: boolean }) {
  const t = useTranslations("admin.companyMoney");
  const locale = useLocale();
  const formatter = useFormatter();
  const errorMessage = useErrorMessage();
  const [page, setPage] = useState(1);
  const query = useCompanyMoneyQuery(
    { page, pageSize: PAGE_SIZE },
    useFreshness(true),
  );
  const { data, loading, error, refresh, isFetching } = useQueryView(query);
  const [updateBalance] = useUpdateCompanyMoneyMutation();
  const [editTransaction] = useEditCompanyMoneyTransactionMutation();
  const [deleteTransaction] = useDeleteCompanyMoneyTransactionMutation();
  const [date, setDate] = useState(() =>
    formatInTimeZone(new Date(), "Asia/Dhaka", "yyyy-MM-dd"),
  );
  const [type, setType] = useState<CompanyMoneyInput["type"]>("ADD");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [actionError, setActionError] = useState<unknown>(null);
  const [invalidAmount, setInvalidAmount] = useState(false);
  const [invalidDate, setInvalidDate] = useState(false);
  const [completed, setCompleted] = useState<CompletedMessage | null>(null);
  const [editing, setEditing] = useState<CompanyMoneyTransactionRecord | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [retryPending, setRetryPending] = useState(false);
  const [activeKind, setActiveKind] = useState<PendingMutation["kind"] | null>(
    null,
  );
  const submitting = useRef(false);
  const pendingMutation = useRef<PendingMutation | null>(null);
  const createDraft = useRef<Draft | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const locked = busy || confirming || retryPending;
  const pendingDelete = activeKind === "delete";
  const money = (value: string) =>
    formatMoney(value, "৳", locale).replace("৳ ", "৳");
  const transactionDate = (value: string) =>
    formatter.dateTime(new Date(`${value}T00:00:00Z`), {
      dateStyle: "medium",
      timeZone: "UTC",
    });

  function restoreCreateDraft() {
    if (createDraft.current) {
      setDate(createDraft.current.date);
      setType(createDraft.current.type);
      setAmount(createDraft.current.amount);
      setNote(createDraft.current.note);
      createDraft.current = null;
    }
    setEditing(null);
  }

  function clearFeedback() {
    setActionError(null);
    setInvalidAmount(false);
    setInvalidDate(false);
    setCompleted(null);
  }

  function beginEdit(record: CompanyMoneyTransactionRecord) {
    if (
      !canManage ||
      locked ||
      submitting.current ||
      editing ||
      pendingMutation.current
    )
      return;
    createDraft.current = { date, type, amount, note };
    setEditing(record);
    setDate(record.date);
    setType(record.type);
    setAmount(record.amount);
    setNote(record.note || "");
    clearFeedback();
    formRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }

  function cancelEdit() {
    if (locked || submitting.current || pendingMutation.current) return;
    restoreCreateDraft();
    clearFeedback();
  }

  async function executePending() {
    const operation = pendingMutation.current;
    if (!canManage || submitting.current || !operation) return;
    submitting.current = true;
    setBusy(true);
    setActiveKind(operation.kind);
    clearFeedback();
    try {
      if (operation.kind === "create") {
        await updateBalance(operation.input).unwrap();
        setAmount("");
        setNote("");
        setCompleted(
          operation.input.type === "ADD" ? "balanceAdded" : "balanceRemoved",
        );
        setPage(1);
      } else if (operation.kind === "edit") {
        await editTransaction({
          id: operation.id,
          input: operation.input,
        }).unwrap();
        restoreCreateDraft();
        setCompleted("transactionUpdated");
        setPage(1);
      } else {
        await deleteTransaction({
          id: operation.id,
          input: operation.input,
        }).unwrap();
        setCompleted("transactionDeleted");
        if (operation.lastOnPage && operation.page > 1) {
          setPage((current) =>
            current === operation.page ? current - 1 : current,
          );
        }
      }
      pendingMutation.current = null;
      setRetryPending(false);
      setActiveKind(null);
    } catch (error) {
      setActionError(error);
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      const insufficientBalance = code === "INSUFFICIENT_COMPANY_BALANCE";
      const superseded = [
        "NOT_FOUND",
        "TRANSACTION_CONFLICT",
        "TRANSACTION_DELETED",
        "IDEMPOTENCY_CONFLICT",
      ].includes(String(code));
      if (isAmbiguousWrite(error)) {
        setRetryPending(true);
        void refresh();
      } else if (!retryPending || insufficientBalance || superseded) {
        // Receipts are checked before version and balance checks. These
        // rejections confirm the retained request cannot apply another change.
        pendingMutation.current = null;
        setRetryPending(false);
        setActiveKind(null);
        if (superseded && operation.kind === "edit") restoreCreateDraft();
        if (superseded && operation.kind === "create") {
          setAmount("");
          setNote("");
        }
        if (insufficientBalance || superseded) void refresh();
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function removeTransaction(record: CompanyMoneyTransactionRecord) {
    if (
      !canManage ||
      locked ||
      submitting.current ||
      editing ||
      pendingMutation.current
    )
      return;
    submitting.current = true;
    setConfirming(true);
    let confirmed = false;
    try {
      confirmed = await confirmAction({
        title: t("deleteTitle"),
        text: t(
          record.type === "ADD"
            ? "deleteAdditionDescription"
            : "deleteRemovalDescription",
          {
            amount: money(record.amount),
            date: transactionDate(record.date),
          },
        ),
        confirmText: t("deleteTransaction"),
        cancelText: t("cancel"),
        danger: true,
      });
    } catch (error) {
      setActionError(error);
    } finally {
      submitting.current = false;
      setConfirming(false);
    }
    if (!confirmed) return;
    pendingMutation.current = {
      kind: "delete",
      id: record.id,
      input: {
        requestId: crypto.randomUUID(),
        expectedVersion: record.version,
      },
      page,
      lastOnPage: data?.items.length === 1,
    };
    await executePending();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || submitting.current || pendingDelete) return;
    if (!pendingMutation.current) {
      const parsedDate = new Date(`${date}T00:00:00Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        date < "0001-01-01" ||
        !Number.isFinite(parsedDate.getTime()) ||
        parsedDate.toISOString().slice(0, 10) !== date
      ) {
        setInvalidDate(true);
        setInvalidAmount(false);
        setActionError(null);
        setCompleted(null);
        return;
      }
    }
    setInvalidDate(false);
    const normalizedAmount = amount.trim();
    if (
      !pendingMutation.current &&
      (!/^\d{1,10}(?:\.\d{1,2})?$/.test(normalizedAmount) ||
        Number(normalizedAmount) <= 0 ||
        Number(normalizedAmount) > 9_999_999_999.99)
    ) {
      setInvalidAmount(true);
      setActionError(null);
      setCompleted(null);
      return;
    }

    // An uncertain response can follow a committed transaction. Freeze its
    // complete payload and UUID so a manual retry confirms that transaction.
    if (!pendingMutation.current) {
      const input: CompanyMoneyInput = {
        requestId: crypto.randomUUID(),
        date,
        type,
        amount: normalizedAmount,
        ...(note.trim() ? { note: note.trim() } : {}),
      };
      pendingMutation.current = editing
        ? {
            kind: "edit",
            id: editing.id,
            input: { ...input, expectedVersion: editing.version },
          }
        : { kind: "create", input };
    }
    await executePending();
  }

  return (
    <div className="stack">
      <PageHeader
        eyebrow={t("eyebrow")}
        title={t("title")}
        description={t("description")}
        action={<Refresh onClick={() => void refresh()} />}
      />
      <ErrorNotice message={error} />
      <section
        className="card card-body"
        aria-label={t("companyBalance")}
        aria-busy={isFetching}
      >
        <div className="calc-header">
          <div className="calc-title">
            <Wallet size={18} aria-hidden="true" />
            <div>
              <h2>{t("companyBalance")}</h2>
              <p>{t(canManage ? "manageHint" : "readOnlyHint")}</p>
            </div>
          </div>
        </div>
        {loading ? (
          <Loading />
        ) : data ? (
          <div className="calc-summary-grid">
            {(
              [
                ["currentBalance", "balance", "availableBalance"],
                ["totalAdded", "totalAdded", "allAdditions"],
                ["totalRemoved", "totalRemoved", "allRemovals"],
              ] as const
            ).map(([label, key, hint]) => (
              <div
                className={`calc-summary-card${key === "balance" ? " calc-total" : ""}`}
                key={key}
              >
                <small>{t(label)}</small>
                <strong className={styles.summaryAmount}>
                  {money(data[key])}
                </strong>
                <p>{t(hint)}</p>
              </div>
            ))}
          </div>
        ) : null}
        {isFetching && data && (
          <p className="muted" role="status">
            {t("refreshing")}
          </p>
        )}
        {canManage && (
          <>
            <ErrorNotice
              message={
                invalidDate
                  ? t("validDate")
                  : invalidAmount
                    ? t("positiveAmount")
                    : actionError
                      ? errorMessage(actionError)
                      : ""
              }
            />
            {completed && <Notice notify>{t(completed)}</Notice>}
            {retryPending && pendingDelete && (
              <div className={styles.deleteRetry}>
                <Notice>{t("unconfirmed")}</Notice>
                <button
                  className="button danger"
                  type="button"
                  disabled={busy}
                  onClick={() => void executePending()}
                >
                  {busy ? t("deleting") : t("retryDelete")}
                </button>
              </div>
            )}
            {editing && (
              <div className={styles.editHeading}>
                <h3>{t("editTransaction")}</h3>
                <p className="muted">
                  {t("editingSummary", {
                    type: t(editing.type === "ADD" ? "added" : "removed"),
                    amount: money(editing.amount),
                    date: transactionDate(editing.date),
                  })}
                </p>
                <p className="muted">{t("editHint")}</p>
              </div>
            )}
            <form
              ref={formRef}
              className={styles.form}
              aria-label={t(editing ? "editTransaction" : "updateBalance")}
              onSubmit={submit}
            >
              {retryPending && !pendingDelete && (
                <div className={styles.retry}>
                  <Notice>{t("unconfirmed")}</Notice>
                </div>
              )}
              <div className="field">
                <label htmlFor="company-money-date">
                  {t("transactionDate")}
                </label>
                <input
                  id="company-money-date"
                  name="date"
                  type="date"
                  min="0001-01-01"
                  max="9999-12-31"
                  required
                  disabled={locked}
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="company-money-type">
                  {t("transactionType")}
                </label>
                <select
                  id="company-money-type"
                  name="type"
                  value={type}
                  disabled={locked}
                  onChange={(event) =>
                    setType(event.target.value === "REMOVE" ? "REMOVE" : "ADD")
                  }
                >
                  <option value="ADD">{t("addBalance")}</option>
                  <option value="REMOVE">{t("removeBalance")}</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="company-money-amount">{t("amountBdt")}</label>
                <input
                  id="company-money-amount"
                  name="amount"
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  max="9999999999.99"
                  step="0.01"
                  required
                  disabled={locked}
                  placeholder="0.00"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </div>
              <div className={`field ${styles.note}`}>
                <label htmlFor="company-money-note">{t("noteOptional")}</label>
                <input
                  id="company-money-note"
                  name="note"
                  type="text"
                  maxLength={500}
                  disabled={locked}
                  placeholder={t("notePlaceholder")}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </div>
              <button
                className="button"
                type="submit"
                disabled={busy || confirming || pendingDelete}
              >
                {editing ? (
                  <Check size={16} aria-hidden="true" />
                ) : type === "ADD" ? (
                  <Plus size={16} aria-hidden="true" />
                ) : (
                  <Minus size={16} aria-hidden="true" />
                )}
                {busy && !pendingDelete
                  ? t("saving")
                  : retryPending && !pendingDelete
                    ? t("retry")
                    : editing
                      ? t("saveChanges")
                      : t(type === "ADD" ? "addBalance" : "removeBalance")}
              </button>
              {editing && (
                <button
                  className="button secondary"
                  type="button"
                  disabled={locked}
                  onClick={cancelEdit}
                >
                  {t("cancelEdit")}
                </button>
              )}
            </form>
          </>
        )}
      </section>
      <section
        className={`card${canManage ? ` ${styles.managedHistory}` : ""}`}
        aria-label={t("history")}
      >
        <div className="card-header">
          <div>
            <h2>{t("history")}</h2>
            <p className="muted">{t("historyDescription")}</p>
          </div>
        </div>
        {loading ? (
          <Loading />
        ) : data ? (
          <>
            {data.items.length ? (
              <Table
                rows={data.items}
                actions={
                  canManage
                    ? (row: DataRow) => {
                        const record = data.items.find(
                          ({ id }) => id === row.id,
                        );
                        if (!record) return null;
                        return (
                          <div className={styles.rowActions}>
                            <button
                              className="button small secondary"
                              type="button"
                              aria-label={t("editTransaction")}
                              disabled={locked || !!editing || isFetching}
                              onClick={() => beginEdit(record)}
                            >
                              <Pencil size={14} aria-hidden="true" />
                              {t("edit")}
                            </button>
                            <button
                              className="button small secondary"
                              type="button"
                              aria-label={t("deleteTransaction")}
                              disabled={locked || !!editing || isFetching}
                              onClick={() => void removeTransaction(record)}
                            >
                              <Trash2 size={14} aria-hidden="true" />
                              {t("delete")}
                            </button>
                          </div>
                        );
                      }
                    : undefined
                }
                columns={[
                  {
                    key: "date",
                    label: t("transactionDate"),
                    render: (value) => (
                      <time dateTime={String(value)}>
                        {transactionDate(String(value))}
                      </time>
                    ),
                  },
                  {
                    key: "createdAt",
                    label: t("dateTime"),
                    render: (value) =>
                      formatter.dateTime(new Date(String(value)), {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }),
                  },
                  {
                    key: "type",
                    label: t("type"),
                    render: (value) => (
                      <span
                        className={`badge ${value === "ADD" ? "green" : "amber"}`}
                      >
                        {t(value === "ADD" ? "added" : "removed")}
                      </span>
                    ),
                  },
                  {
                    key: "amount",
                    label: t("amount"),
                    render: (value, row) => (
                      <span
                        className={`${styles.amount} ${row.type === "ADD" ? styles.added : styles.removed}`}
                      >
                        {row.type === "ADD" ? "+" : "−"}
                        {money(String(value))}
                      </span>
                    ),
                  },
                  {
                    key: "note",
                    label: t("note"),
                    render: (value) => (
                      <span className={styles.noteText}>
                        {String(value || "—")}
                      </span>
                    ),
                  },
                  {
                    key: "createdBy",
                    label: t("recordedBy"),
                    render: (value) => {
                      const actor = value as {
                        name: string | null;
                        email: string;
                      } | null;
                      return actor
                        ? actor.name || actor.email
                        : t("deletedUser");
                    },
                  },
                ]}
              />
            ) : (
              <Empty
                title={t("emptyTitle")}
                description={t("emptyDescription")}
              />
            )}
            <Pagination
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              loading={isFetching || locked || !!editing}
              onPage={setPage}
            />
          </>
        ) : null}
      </section>
    </div>
  );
}
