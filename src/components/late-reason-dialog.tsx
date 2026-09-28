"use client";

import { useTranslations } from "next-intl";
import { useEmployeeError } from "./employee-feedback";

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
  attendanceApi,
  useSaveLateReasonMutation,
  useLazyEmployeeDayQuery,
} from "@/store/features/attendance/api";
import { isAmbiguousWrite } from "@/lib/client/attendance-ceremony";
import { useAppDispatch } from "@/store/hooks";

export function LateReasonDialog({
  attendance,
  onClose,
  onSaved,
}: {
  attendance: DataRow;
  onClose: () => void;
  onSaved: (attendance: DataRow) => void;
}) {
  const t = useTranslations("employee");
  const [reason, setReason] = useState("");
  const [requestApproval, setRequestApproval] = useState(false);
  const [saveReason, { isLoading: writing }] = useSaveLateReasonMutation();
  const dispatch = useAppDispatch();
  const [readDay, { isFetching: checking }] = useLazyEmployeeDayQuery();
  const [needsReconcile, setNeedsReconcile] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const saving = writing || checking || reconciling;
  const submitting = useRef(false);
  const [error, setError] = useEmployeeError();
  const input = useRef<HTMLTextAreaElement>(null);
  const close = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);

  useEffect(() => {
    if (!saving) input.current?.focus();
  }, [saving]);

  async function reconcile() {
    setReconciling(true);
    try {
      // An older dashboard poll cannot confirm this write's outcome.
      const running = dispatch(
        attendanceApi.util.getRunningQueryThunk("employeeDay", undefined),
      );
      if (running) {
        running.abort();
        await running;
      }
      const day = await readDay(undefined, false).unwrap();
      const current = [day.today, ...day.recent].find(
        (record) => record?.id === attendance.id,
      );
      setNeedsReconcile(false);
      if (
        current?.lateReason &&
        (!requestApproval || current.lateApprovalStatus)
      )
        onSaved(current);
    } catch (error) {
      setError(error);
    } finally {
      setReconciling(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || needsReconcile) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      setError({ key: "lateReason.required" });
      input.current?.focus();
      return;
    }
    submitting.current = true;
    setError("");
    try {
      const saved = await saveReason({
        attendanceId: String(attendance.id),
        reason: trimmed,
        ...(requestApproval ? { requestApproval: true } : {}),
      }).unwrap();
      onSaved(saved);
    } catch (error) {
      setError(error);
      if (isAmbiguousWrite(error)) {
        setNeedsReconcile(true);
        await reconcile();
      }
    } finally {
      submitting.current = false;
    }
  }

  return (
    <Modal title={t("lateReason.title")} close={close}>
      <form onSubmit={submit} aria-busy={saving}>
        <p
          id="late-reason-description"
          className="muted"
          style={{ marginBottom: 20 }}
        >
          {t("lateReason.description", {
            count: Number(attendance.lateMinutes),
          })}
        </p>
        <ErrorNotice message={error} />
        <div className="field">
          <label htmlFor="late-attendance-reason">{t("common.reason")}</label>
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
            placeholder={t("lateReason.placeholder")}
          />
          <small id="late-reason-limit">
            {t("lateReason.characters", { count: reason.length })}
          </small>
        </div>
        <label className="field-checkbox">
          <input
            type="checkbox"
            name="requestApproval"
            checked={requestApproval}
            disabled={saving || needsReconcile}
            onChange={(event) => setRequestApproval(event.target.checked)}
            aria-describedby="late-approval-description"
          />
          {t("lateReason.requestApproval")}
        </label>
        <p
          id="late-approval-description"
          className="muted"
          style={{ marginTop: 8 }}
        >
          {t("lateReason.approvalDescription")}
        </p>
        {needsReconcile && (
          <button
            type="button"
            className="button secondary"
            disabled={saving}
            onClick={() => void reconcile()}
          >
            {t("lateReason.refresh")}
          </button>
        )}
        <div className="form-actions">
          <button
            type="button"
            className="button secondary"
            disabled={saving}
            onClick={close}
          >
            {t("lateReason.later")}
          </button>
          <button
            type="submit"
            className="button"
            disabled={saving || needsReconcile}
          >
            {saving
              ? t("common.saving")
              : requestApproval
                ? t("lateReason.submitRequest")
                : t("lateReason.submit")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
