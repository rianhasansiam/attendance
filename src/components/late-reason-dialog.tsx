"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Modal } from "./modal";
import { ErrorNotice, type DataRow } from "./ui";
import {
  useSaveLateReasonMutation,
  useLazyEmployeeDayQuery,
} from "@/store/features/attendance/api";
import { errorMessage } from "@/store/api/errors";
import { isAmbiguousWrite } from "@/lib/client/attendance-ceremony";

export function LateReasonDialog({
  attendance,
  onClose,
  onSaved,
}: {
  attendance: DataRow;
  onClose: () => void;
  onSaved: (attendance: DataRow) => void;
}) {
  const [reason, setReason] = useState("");
  const [saveReason, { isLoading: writing }] = useSaveLateReasonMutation();
  const [readDay, { isFetching: checking }] = useLazyEmployeeDayQuery();
  const [needsReconcile, setNeedsReconcile] = useState(false);
  const saving = writing || checking;
  const submitting = useRef(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const close = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);

  useEffect(() => {
    if (!saving) input.current?.focus();
  }, [saving]);

  async function reconcile() {
    try {
      const day = await readDay(undefined, false).unwrap();
      const current = [day.today, ...day.recent].find(
        (record) => record?.id === attendance.id,
      );
      setNeedsReconcile(false);
      if (current?.lateReason) onSaved(current);
    } catch (error) {
      setError(errorMessage(error));
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || needsReconcile) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      setError("Please enter a reason for your late attendance.");
      input.current?.focus();
      return;
    }
    submitting.current = true;
    setError("");
    try {
      const saved = await saveReason({
        attendanceId: String(attendance.id),
        reason: trimmed,
      }).unwrap();
      onSaved(saved);
    } catch (error) {
      setError(errorMessage(error));
      if (isAmbiguousWrite(error)) {
        setNeedsReconcile(true);
        await reconcile();
      }
    } finally {
      submitting.current = false;
    }
  }

  return (
    <Modal title="Reason for late attendance" close={close}>
      <form onSubmit={submit} aria-busy={saving}>
        <p
          id="late-reason-description"
          className="muted"
          style={{ marginBottom: 20 }}
        >
          Your check-in has been recorded. You arrived{" "}
          {Number(attendance.lateMinutes)}{" "}
          {Number(attendance.lateMinutes) === 1 ? "minute" : "minutes"} late.
          Please tell us the reason for your late attendance.
        </p>
        <ErrorNotice message={error} />
        <div className="field">
          <label htmlFor="late-attendance-reason">Reason</label>
          <textarea
            ref={input}
            id="late-attendance-reason"
            name="reason"
            required
            maxLength={1000}
            rows={4}
            value={reason}
            disabled={saving}
            onChange={(event) => setReason(event.target.value)}
            aria-describedby="late-reason-description late-reason-limit"
            placeholder="Tell us why you were late…"
          />
          <small id="late-reason-limit">{reason.length}/1000 characters</small>
        </div>
        {needsReconcile && (
          <button
            type="button"
            className="button secondary"
            disabled={saving}
            onClick={() => void reconcile()}
          >
            Refresh attendance before trying again
          </button>
        )}
        <div className="form-actions">
          <button
            type="button"
            className="button secondary"
            disabled={saving}
            onClick={close}
          >
            Later
          </button>
          <button
            type="submit"
            className="button"
            disabled={saving || needsReconcile}
          >
            {saving ? "Saving…" : "Submit reason"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
