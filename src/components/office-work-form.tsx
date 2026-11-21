"use client";

import { useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useDebouncedValue } from "@/lib/client/use-debounced-value";
import { useFreshness } from "@/store/freshness";
import { useQueryView } from "@/store/use-query-view";
import { useOfficeWorkAssigneesQuery } from "@/store/features/office-work/api";
import type {
  OfficeWorkPerson,
  OfficeWorkPriority,
  OfficeWorkTaskDTO,
} from "@/modules/office-work/contracts";
import { Modal } from "./modal";
import { ErrorNotice, Loading } from "./ui";
import styles from "./office-work-workspace.module.css";

export function OfficeWorkAssignee({
  value,
  onChange,
  disabled,
  current,
}: {
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
  current?: OfficeWorkPerson | null;
}) {
  const t = useTranslations("officeWork");
  const [search, setSearch] = useState("");
  const debounced = useDebouncedValue(search);
  const result = useOfficeWorkAssigneesQuery(
    debounced.trim() ? { search: debounced.trim() } : {},
    useFreshness(),
  );
  const view = useQueryView(result);
  return (
    <div className={`field ${styles.people}`}>
      <label htmlFor="office-work-person-search">{t("searchAssignees")}</label>
      <input
        id="office-work-person-search"
        type="search"
        maxLength={200}
        value={search}
        disabled={disabled}
        onChange={(event) => setSearch(event.target.value)}
      />
      <label htmlFor="office-work-assignee">{t("assignee")}</label>
      <select
        id="office-work-assignee"
        value={value}
        required
        disabled={disabled || view.loading || !!view.error}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{t("selectAssignee")}</option>
        {value && !view.data?.some((person) => person.id === value) && (
          <option value={value}>
            {current?.id === value
              ? current.name || current.email
              : t("currentSelection")}
          </option>
        )}
        {view.data?.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name || person.email} · {person.email}
          </option>
        ))}
      </select>
      <small>{t("eligibleHint")}</small>
      {view.loading && <Loading />}
      {view.data?.length === 0 && (
        <small role="status">{t("noEligible")}</small>
      )}
      {view.error && (
        <>
          <ErrorNotice message={t("lookupsFailed")} notify={false} />
          <button
            className="button small secondary"
            type="button"
            onClick={() => void view.refresh()}
          >
            {t("retry")}
          </button>
        </>
      )}
    </div>
  );
}

export type OfficeWorkFormValues = {
  title: string;
  description: string | null;
  assigneeId: string;
  priority: OfficeWorkPriority;
  dueDate: string | null;
};

export function OfficeWorkForm({
  task,
  reassignOnly,
  busy,
  blocked,
  error,
  close,
  refresh,
  submit,
}: {
  task?: OfficeWorkTaskDTO;
  reassignOnly?: boolean;
  busy: boolean;
  blocked: boolean;
  error: string;
  close: () => void;
  refresh: () => void;
  submit: (values: OfficeWorkFormValues, requestId: string) => Promise<void>;
}) {
  const t = useTranslations("officeWork");
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [assigneeId, setAssigneeId] = useState(task?.assigneeId ?? "");
  const [priority, setPriority] = useState<OfficeWorkPriority>(
    task?.priority ?? "MEDIUM",
  );
  const [dueDate, setDueDate] = useState(task?.dueDate ?? "");
  const [validation, setValidation] = useState("");
  const requestId = useRef<string | null>(null);
  const disabled = busy || blocked;
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    if (!reassignOnly && !title.trim()) {
      setValidation(t("missingTitle"));
      return;
    }
    if ((!task || reassignOnly) && !assigneeId) {
      setValidation(t("requiredAssignee"));
      return;
    }
    if (reassignOnly && assigneeId === task?.assigneeId) {
      setValidation(t("assigneeUnchanged"));
      return;
    }
    setValidation("");
    requestId.current ??= crypto.randomUUID();
    await submit(
      {
        title: title.trim(),
        description: description.trim() || null,
        assigneeId,
        priority,
        dueDate: dueDate || null,
      },
      requestId.current,
    );
  }
  return (
    <Modal
      title={reassignOnly ? t("reassign") : task ? t("edit") : t("create")}
      close={() => !busy && close()}
    >
      <form className={styles.form} onSubmit={onSubmit}>
        <ErrorNotice message={validation || error} notify={false} />
        {blocked && (
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={refresh}
          >
            {t("refreshTask")}
          </button>
        )}
        {!reassignOnly && (
          <>
            <div className="field">
              <label htmlFor="office-work-title">{t("titleLabel")}</label>
              <input
                id="office-work-title"
                required
                maxLength={200}
                value={title}
                disabled={disabled}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="office-work-description">
                {t("descriptionLabel")}
              </label>
              <textarea
                id="office-work-description"
                maxLength={10000}
                rows={5}
                value={description}
                disabled={disabled}
                onChange={(event) => setDescription(event.target.value)}
                aria-describedby="office-work-description-hint"
              />
              <small id="office-work-description-hint">
                {t("descriptionHint")}
              </small>
            </div>
          </>
        )}
        {!task || reassignOnly ? (
          <OfficeWorkAssignee
            value={assigneeId}
            onChange={setAssigneeId}
            disabled={disabled}
            current={task?.assignee}
          />
        ) : (
          <div className="field">
            <label htmlFor="office-work-current-assignee">
              {t("assignee")}
            </label>
            <input
              id="office-work-current-assignee"
              readOnly
              value={
                task.assignee?.name || task.assignee?.email || t("deletedUser")
              }
            />
            <small>{t("assigneeEditHint")}</small>
          </div>
        )}
        {reassignOnly && task?.status !== "PENDING" && (
          <p className={styles.alert}>{t("reassignWarning")}</p>
        )}
        {!reassignOnly && (
          <div className={styles.formGrid}>
            <div className="field">
              <label htmlFor="office-work-priority">{t("priority")}</label>
              <select
                id="office-work-priority"
                value={priority}
                disabled={disabled}
                onChange={(event) =>
                  setPriority(event.target.value as OfficeWorkPriority)
                }
              >
                <option value="LOW">{t("low")}</option>
                <option value="MEDIUM">{t("medium")}</option>
                <option value="HIGH">{t("high")}</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="office-work-due">{t("dueDate")}</label>
              <input
                id="office-work-due"
                type="date"
                value={dueDate}
                disabled={disabled}
                onChange={(event) => setDueDate(event.target.value)}
                aria-describedby="office-work-due-hint"
              />
              <small id="office-work-due-hint">{t("dueDateHint")}</small>
            </div>
          </div>
        )}
        <div className="buttons">
          <button className="button" type="submit" disabled={disabled}>
            {busy ? t("saving") : reassignOnly ? t("reassign") : t("save")}
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={close}
          >
            {t("cancel")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
