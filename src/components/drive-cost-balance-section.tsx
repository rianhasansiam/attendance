"use client";

import { useRef, useState, type FormEvent } from "react";
import { Plus, Wallet } from "lucide-react";
import { ErrorNotice, Loading, Notice } from "./ui";
import { isAmbiguousWrite } from "@/lib/client/attendance-ceremony";
import { useLocale, useTranslations } from "next-intl";
import { useExpenseFeedback } from "./expense-feedback";
import { formatMoney } from "@/i18n/format-money";
import {
  useAddDriveCostBalanceMutation,
  type AddDriveCostBalanceInput,
  type DriveCostBalance,
} from "@/store/features/drive-costs/api";

export function DriveCostBalanceSection({
  canAddBalance,
  data,
  error,
  loading,
  isFetching,
  refresh,
}: {
  canAddBalance: boolean;
  data?: DriveCostBalance;
  error: string;
  loading: boolean;
  isFetching: boolean;
  refresh: () => void;
}) {
  const t = useTranslations("expenses");
  const locale = useLocale();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [actionError, setActionError] = useExpenseFeedback();
  const [message, setMessage] = useExpenseFeedback();
  const [busy, setBusy] = useState(false);
  const [retryPending, setRetryPending] = useState(false);
  const submitting = useRef(false);
  const pendingInput = useRef<AddDriveCostBalanceInput | null>(null);
  const [addBalance] = useAddDriveCostBalanceMutation();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAddBalance || submitting.current) return;
    const normalizedAmount = amount.trim();
    if (
      !pendingInput.current &&
      (!/^\d{1,10}(?:\.\d{1,2})?$/.test(normalizedAmount) ||
        Number(normalizedAmount) <= 0 ||
        Number(normalizedAmount) > 9_999_999_999.99)
    ) {
      setActionError({ key: "positiveBalanceAmount" });
      return;
    }

    // Retain both the id and payload after an uncertain response. A manual
    // retry confirms the same addition instead of creating another credit.
    pendingInput.current ??= {
      requestId: crypto.randomUUID(),
      amount: normalizedAmount,
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    submitting.current = true;
    setBusy(true);
    setActionError("");
    setMessage("");
    try {
      await addBalance(pendingInput.current).unwrap();
      pendingInput.current = null;
      setRetryPending(false);
      setAmount("");
      setNote("");
      setMessage({ key: "driveBalanceAdded" });
    } catch (error) {
      setActionError({ error });
      if (isAmbiguousWrite(error)) {
        setRetryPending(true);
        refresh();
      } else if (!retryPending) {
        pendingInput.current = null;
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <section
      className="card card-body drive-balance-card"
      aria-label={t("driveBalance")}
    >
      <div className="calc-header">
        <div className="calc-title">
          <Wallet size={18} />
          <div>
            <h3>{t("driveBalance")}</h3>
            <p>{t("driveBalanceDescription")}</p>
          </div>
        </div>
      </div>
      <ErrorNotice message={error || actionError} />
      {loading ? (
        <Loading />
      ) : data ? (
        <div className="calc-summary-grid">
          <div
            className={`calc-summary-card calc-total${data.balance.startsWith("-") ? " balance-negative" : ""}`}
          >
            <small>{t("currentBalanceLower")}</small>
            <strong>
              {formatMoney(data.balance, "৳", locale).replace("৳ ", "৳")}
            </strong>
            <p>{t("availableDrive")}</p>
          </div>
          <div className="calc-summary-card">
            <small>{t("totalAdded")}</small>
            <strong>
              {formatMoney(data.totalAdded, "৳", locale).replace("৳ ", "৳")}
            </strong>
            <p>{t("addedByAdmins")}</p>
          </div>
          <div className="calc-summary-card">
            <small>{t("paidTrips")}</small>
            <strong>
              {formatMoney(data.totalPaid, "৳", locale).replace("৳ ", "৳")}
            </strong>
            <p>{t("deductedBalance")}</p>
          </div>
        </div>
      ) : null}
      {isFetching && data && (
        <p className="muted" role="status">
          {t("refreshingBalance")}
        </p>
      )}
      {message && <Notice notify>{message}</Notice>}
      {canAddBalance && (
        <form
          className="calc-inputs drive-balance-form"
          aria-label={t("addDriveBalance")}
          onSubmit={submit}
        >
          {retryPending && (
            <div className="drive-balance-retry">
              <Notice>{t("balanceUnconfirmed")}</Notice>
            </div>
          )}
          <div className="field">
            <label htmlFor="drive-balance-amount">{t("amountBdt")}</label>
            <input
              id="drive-balance-amount"
              name="amount"
              type="number"
              inputMode="decimal"
              min="0.01"
              max="9999999999.99"
              step="0.01"
              required
              disabled={busy || retryPending}
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </div>
          <div className="field drive-balance-note">
            <label htmlFor="drive-balance-note">{t("noteOptional")}</label>
            <input
              id="drive-balance-note"
              name="note"
              type="text"
              maxLength={500}
              disabled={busy || retryPending}
              placeholder={t("budgetExample")}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <button className="button calc-run-btn" type="submit" disabled={busy}>
            <Plus size={16} />
            {busy
              ? t("adding")
              : retryPending
                ? t("retryBalance")
                : t("addBalanceLower")}
          </button>
        </form>
      )}
    </section>
  );
}
