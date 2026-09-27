"use client";

import { useRef, useState, type FormEvent } from "react";
import { Plus, Wallet } from "lucide-react";
import { ErrorNotice, Loading, Notice } from "./ui";
import { isAmbiguousWrite } from "@/lib/client/attendance-ceremony";
import { errorMessage } from "@/store/api/errors";
import {
  useAddDriveCostBalanceMutation,
  type AddDriveCostBalanceInput,
  type DriveCostBalance,
} from "@/store/features/drive-costs/api";

function taka(amount: string) {
  const [, sign, whole, fraction = ""] = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(
    amount,
  )!;
  return `${sign}৳${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction.padEnd(2, "0")}`;
}

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
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
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
      setActionError(
        "Enter an amount greater than zero, up to 9,999,999,999.99, with at most two decimal places.",
      );
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
      setMessage("Drive cost balance added successfully.");
    } catch (error) {
      setActionError(errorMessage(error));
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
      aria-label="Drive cost balance"
    >
      <div className="calc-header">
        <div className="calc-title">
          <Wallet size={18} />
          <div>
            <h3>Drive cost balance</h3>
            <p>
              Total balance added minus all paid trips, across all dates. The
              balance can be negative.
            </p>
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
            <small>Current balance</small>
            <strong>{taka(data.balance)}</strong>
            <p>Available for drive costs</p>
          </div>
          <div className="calc-summary-card">
            <small>Total added</small>
            <strong>{taka(data.totalAdded)}</strong>
            <p>Added by super admins</p>
          </div>
          <div className="calc-summary-card">
            <small>Paid trips</small>
            <strong>{taka(data.totalPaid)}</strong>
            <p>Deducted from the balance</p>
          </div>
        </div>
      ) : null}
      {isFetching && data && (
        <p className="muted" role="status">
          Refreshing balance…
        </p>
      )}
      {message && <Notice notify>{message}</Notice>}
      {canAddBalance && (
        <form
          className="calc-inputs drive-balance-form"
          aria-label="Add drive cost balance"
          onSubmit={submit}
        >
          {retryPending && (
            <div className="drive-balance-retry">
              <Notice>
                The addition could not be confirmed. Retry this balance addition
                to confirm the result safely.
              </Notice>
            </div>
          )}
          <div className="field">
            <label htmlFor="drive-balance-amount">Amount (BDT)</label>
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
            <label htmlFor="drive-balance-note">Note (optional)</label>
            <input
              id="drive-balance-note"
              name="note"
              type="text"
              maxLength={500}
              disabled={busy || retryPending}
              placeholder="e.g. October travel budget"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <button className="button calc-run-btn" type="submit" disabled={busy}>
            <Plus size={16} />
            {busy
              ? "Adding…"
              : retryPending
                ? "Retry balance addition"
                : "Add balance"}
          </button>
        </form>
      )}
    </section>
  );
}
