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
import { api } from "./use-resource";

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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const close = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);

  useEffect(() => {
    if (!saving) input.current?.focus();
  }, [saving]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      setError("Please enter a reason for your late attendance.");
      input.current?.focus();
      return;
    }
    setSaving(true);
    setError("");
    try {
      const saved = await api<DataRow>("/api/attendance/late-reason", {
        method: "POST",
        body: JSON.stringify({ attendanceId: attendance.id, reason: trimmed }),
      });
      onSaved(saved);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to save your reason. Please try again.",
      );
    } finally {
      setSaving(false);
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
        <div className="form-actions">
          <button
            type="button"
            className="button secondary"
            disabled={saving}
            onClick={close}
          >
            Later
          </button>
          <button type="submit" className="button" disabled={saving}>
            {saving ? "Saving…" : "Submit reason"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
