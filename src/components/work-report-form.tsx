"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { confirmAction } from "@/lib/client/alerts";
import type { WorkReportDTO } from "@/modules/work-report/contracts";
import { Modal } from "./modal";
import { date, ErrorNotice } from "./ui";
import styles from "./work-report-workspace.module.css";

export type WorkReportFormValues = { title: string | null; content: string };
export function WorkReportForm({
  report,
  today,
  timezone,
  busy,
  blocked,
  error,
  submitDisabled = false,
  onSave,
  onRefresh,
  onClose,
  onClear,
}: {
  report?: WorkReportDTO;
  today?: string;
  timezone: string;
  busy: boolean;
  blocked: boolean;
  error: string;
  submitDisabled?: boolean;
  onSave: (values: WorkReportFormValues, requestId: string) => Promise<boolean>;
  onRefresh: () => void;
  onClose?: () => void;
  onClear?: () => void;
}) {
  const t = useTranslations("workReport");
  const locale = useLocale();
  const [title, setTitle] = useState(report?.title ?? "");
  const [content, setContent] = useState(report?.content ?? "");
  const [validation, setValidation] = useState("");
  const requestId = useRef<string | null>(null);
  const submitting = useRef(false);
  const confirming = useRef(false);
  const dirty =
    title !== (report?.title ?? "") || content !== (report?.content ?? "");
  const disabled = busy || blocked;
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);
  async function close() {
    if (!onClose || busy || submitting.current || confirming.current) return;
    if (!dirty) {
      onClose();
      return;
    }
    confirming.current = true;
    try {
      if (
        await confirmAction({
          title: t("discardConfirm"),
          text: t("discardDescription"),
          confirmText: t("discard"),
          danger: true,
        })
      )
        onClose();
    } finally {
      confirming.current = false;
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || submitting.current) return;
    if (!content.trim()) {
      setValidation(t("contentRequired"));
      return;
    }
    if (content.trim().length > 10000) {
      setValidation(t("contentTooLong"));
      return;
    }
    if (title.trim().length > 200) {
      setValidation(t("titleTooLong"));
      return;
    }
    setValidation("");
    submitting.current = true;
    requestId.current ??= crypto.randomUUID();
    const submittedTitle = title,
      submittedContent = content;
    try {
      const success = await onSave(
        { title: title.trim() || null, content: content.trim() },
        requestId.current,
      );
      if (success && !report) {
        setTitle((current) => (current === submittedTitle ? "" : current));
        setContent((current) => (current === submittedContent ? "" : current));
        requestId.current = null;
      }
    } finally {
      submitting.current = false;
    }
  }
  async function clear() {
    if (report || busy || submitting.current || confirming.current) return;
    confirming.current = true;
    try {
      if (
        await confirmAction({
          title: t("discardConfirm"),
          text: t("discardDescription"),
          confirmText: t("clearForm"),
          danger: true,
        })
      ) {
        setTitle("");
        setContent("");
        setValidation("");
        requestId.current = null;
        onClear?.();
      }
    } finally {
      confirming.current = false;
    }
  }
  const form = (
    <form className={styles.composer} onSubmit={submit}>
      <ErrorNotice message={validation || error} notify={false} />
      {report ? (
        <p className={styles.caption}>
          {t("editDate", { date: date(report.workDate, locale) })}
        </p>
      ) : (
        <div>
          <p className={styles.caption}>
            {today
              ? t("postingFor", { date: date(today, locale), timezone })
              : t("postingToday")}
          </p>
          <p className={styles.caption}>{t("teamVisibility")}</p>
        </div>
      )}
      {blocked && (
        <div className={styles.reconcile} role="alert">
          <p>{t("changesKept")}</p>
          <button
            className="button small secondary"
            type="button"
            disabled={busy}
            onClick={onRefresh}
          >
            {report ? t("reloadLatest") : t("refresh")}
          </button>
        </div>
      )}
      <div className="field">
        <label htmlFor={report ? "report-edit-title" : "report-title"}>
          {t("titleLabel")}
        </label>
        <input
          id={report ? "report-edit-title" : "report-title"}
          value={title}
          maxLength={200}
          disabled={disabled}
          placeholder={t("titlePlaceholder")}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={report ? "report-edit-content" : "report-content"}>
          {t("contentLabel")}
        </label>
        <textarea
          id={report ? "report-edit-content" : "report-content"}
          required
          rows={report ? 9 : 6}
          maxLength={10000}
          value={content}
          disabled={disabled}
          placeholder={t("contentPlaceholder")}
          onChange={(event) => setContent(event.target.value)}
        />
      </div>
      <div className={styles.composerFooter}>
        <div className="buttons">
          <button
            className="button"
            type="submit"
            disabled={disabled || submitDisabled || (!report && !today)}
          >
            {busy
              ? t(report ? "saving" : "posting")
              : t(report ? "save" : "post")}
          </button>
          {report && (
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => void close()}
            >
              {t("cancel")}
            </button>
          )}
          {!report && (title || content) && (
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => void clear()}
            >
              {t("clearForm")}
            </button>
          )}
        </div>
        <small>{t("characters", { count: content.length })}</small>
      </div>
    </form>
  );
  return report ? (
    <Modal title={t("editReport")} close={() => void close()}>
      {form}
    </Modal>
  ) : (
    <section className="card" aria-labelledby="work-report-composer">
      <div className="card-header">
        <h2 id="work-report-composer">{t("composer")}</h2>
      </div>
      <div className="card-body">{form}</div>
    </section>
  );
}
