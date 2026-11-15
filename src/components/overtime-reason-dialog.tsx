"use client";

import { useRef, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { CheckoutPreview } from "@/store/features/attendance/contracts";
import { Modal } from "./modal";
import { duration, ErrorNotice } from "./ui";

export function OvertimeReasonDialog({
  preview,
  error,
  onClose,
  onSubmit,
}: {
  preview: CheckoutPreview;
  error: string;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const t = useTranslations("employee");
  const locale = useLocale();
  const [reason, setReason] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const timestamp = (value: string) =>
    new Date(value).toLocaleString(locale, { timeZone: preview.timezone });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const trimmed = reason.trim();
    if ([...trimmed].length < 10 || trimmed.length > 1000) {
      setInvalid(true);
      input.current?.focus();
      return;
    }
    submitting.current = true;
    setBusy(true);
    try {
      await onSubmit(trimmed);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal title={t("overtimeReason.title")} close={() => !busy && onClose()}>
      <form onSubmit={submit} aria-busy={busy}>
        <p className="muted" id="overtime-reason-description">
          {t("overtimeReason.description")}
        </p>
        <dl className="stack" style={{ margin: "20px 0" }}>
          <div>
            <dt className="muted">{t("columns.employee")}</dt>
            <dd style={{ margin: 0 }}>{preview.employeeName}</dd>
          </div>
          <div>
            <dt className="muted">{t("overtimeReason.scheduledEnd")}</dt>
            <dd style={{ margin: 0 }}>{timestamp(preview.scheduledEndAt)}</dd>
          </div>
          <div>
            <dt className="muted">{t("overtimeReason.checkoutPreview")}</dt>
            <dd style={{ margin: 0 }}>{timestamp(preview.serverTime)}</dd>
          </div>
          <div>
            <dt className="muted">{t("overtimeReason.extraDuration")}</dt>
            <dd style={{ margin: 0 }}>
              {duration(preview.extraMinutes, locale)}
            </dd>
          </div>
        </dl>
        <p className="muted">{t("overtimeReason.previewNote")}</p>
        <ErrorNotice message={invalid ? t("overtimeReason.required") : error} />
        <div className="field">
          <label htmlFor="checkout-overtime-reason">
            {t("overtimeReason.reason")}
          </label>
          <textarea
            ref={input}
            id="checkout-overtime-reason"
            name="overtimeReason"
            required
            minLength={10}
            maxLength={1000}
            rows={4}
            value={reason}
            disabled={busy}
            aria-invalid={invalid || undefined}
            aria-describedby="overtime-reason-description overtime-reason-limit"
            onChange={(event) => {
              setReason(event.target.value);
              setInvalid(false);
            }}
          />
          <small id="overtime-reason-limit">
            {t("overtimeReason.characters", { count: reason.length })}
          </small>
        </div>
        <div className="form-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            {t("common.cancel")}
          </button>
          <button className="button" type="submit" disabled={busy}>
            {busy ? t("common.saving") : t("overtimeReason.submit")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
