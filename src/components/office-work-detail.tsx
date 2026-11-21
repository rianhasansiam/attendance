"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useOfficeWorkTaskQuery } from "@/store/features/office-work/api";
import { useFreshness } from "@/store/freshness";
import { useQueryView } from "@/store/use-query-view";
import type {
  OfficeWorkActionInput,
  OfficeWorkActivityDTO,
  OfficeWorkPerson,
  OfficeWorkTaskDTO,
} from "@/modules/office-work/contracts";
import { Modal } from "./modal";
import { date, ErrorNotice, Loading, Pagination } from "./ui";
import styles from "./office-work-workspace.module.css";

export type OfficeWorkAction = Exclude<
  OfficeWorkActionInput["action"],
  "reassign"
>;

export function OfficeWorkPersonLabel({
  person,
}: {
  person: OfficeWorkPerson | null;
}) {
  const t = useTranslations("officeWork");
  return (
    <span className={styles.person}>
      {person?.name || person?.email || t("deletedUser")}
    </span>
  );
}

export function OfficeWorkBadges({ task }: { task: OfficeWorkTaskDTO }) {
  const t = useTranslations("officeWork");
  const status = {
    PENDING: "pending",
    PROCESSING: "processing",
    DONE: "done",
  } as const;
  const priority = { LOW: "low", MEDIUM: "medium", HIGH: "high" } as const;
  return (
    <div className={styles.badges}>
      <span className={styles.badge}>{t(status[task.status])}</span>
      <span
        className={`${styles.badge} ${task.priority === "HIGH" ? styles.urgent : ""}`}
      >
        {t("priority")}: {t(priority[task.priority])}
      </span>
      {task.overdue && (
        <span className={`${styles.badge} ${styles.urgent}`}>
          {t("overdue")}
        </span>
      )}
      {task.archivedAt && (
        <span className={styles.badge}>
          {t("archivedTasks")} · {t("readOnly")}
        </span>
      )}
    </div>
  );
}

export function OfficeWorkActions({
  task,
  disabled,
  onEdit,
  onReassign,
  onAction,
}: {
  task: OfficeWorkTaskDTO;
  disabled: boolean;
  onEdit: (task: OfficeWorkTaskDTO) => void;
  onReassign: (task: OfficeWorkTaskDTO) => void;
  onAction: (task: OfficeWorkTaskDTO, action: OfficeWorkAction) => void;
}) {
  const t = useTranslations("officeWork");
  const p = task.permissions;
  return (
    <div className={styles.actionButtons}>
      {p.canStart && (
        <button
          className="button small"
          disabled={disabled}
          onClick={() => onAction(task, "start")}
        >
          {t("start")}
        </button>
      )}
      {p.canComplete && (
        <button
          className="button small"
          disabled={disabled}
          onClick={() => onAction(task, "complete")}
        >
          {t("complete")}
        </button>
      )}
      {p.canEdit && (
        <button
          className="button small secondary"
          disabled={disabled}
          onClick={() => onEdit(task)}
        >
          {t("edit")}
        </button>
      )}
      {p.canReassign && (
        <button
          className="button small secondary"
          disabled={disabled}
          onClick={() => onReassign(task)}
        >
          {t("reassign")}
        </button>
      )}
      {p.canReopen && (
        <button
          className="button small secondary"
          disabled={disabled}
          onClick={() => onAction(task, "reopen")}
        >
          {t("reopen")}
        </button>
      )}
      {p.canArchive && (
        <button
          className="button small danger"
          disabled={disabled}
          onClick={() => onAction(task, "archive")}
        >
          {t("archive")}
        </button>
      )}
    </div>
  );
}

function OfficeWorkActivity({
  activity,
  timezone,
}: {
  activity: OfficeWorkActivityDTO;
  timezone: string;
}) {
  const t = useTranslations("officeWork");
  const locale = useLocale();
  const names: Record<string, string> = {
    CREATED: t("activityCreated"),
    UPDATED: t("activityUpdated"),
    EDITED: t("activityUpdated"),
    REASSIGNED: t("activityReassigned"),
    STARTED: t("activityStarted"),
    COMPLETED: t("activityCompleted"),
    STATUS_CHANGED: t("statusChanged"),
    REOPENED: t("activityReopened"),
    ARCHIVED: t("activityArchived"),
    CREATE: t("activityCreated"),
    UPDATE: t("activityUpdated"),
    REASSIGN: t("activityReassigned"),
    START: t("activityStarted"),
    COMPLETE: t("activityCompleted"),
    REOPEN: t("activityReopened"),
    ARCHIVE: t("activityArchived"),
  };
  const fieldNames: Record<string, string> = {
    title: t("titleLabel"),
    description: t("descriptionLabel"),
    status: t("status"),
    priority: t("priority"),
    dueDate: t("dueDate"),
    assigneeId: t("assignee"),
    assignee: t("assignee"),
    startedAt: t("startedAt"),
    completedAt: t("completedAt"),
    archivedAt: t("archivedAt"),
  };
  const statuses: Record<string, string> = {
    PENDING: t("pending"),
    PROCESSING: t("processing"),
    DONE: t("done"),
    LOW: t("low"),
    MEDIUM: t("medium"),
    HIGH: t("high"),
  };
  const timestamp = (value: string) =>
    new Date(value).toLocaleString(locale, { timeZone: timezone });
  const valueLabel = (value: unknown, key: string): string => {
    if (value == null || value === "") return "—";
    if (typeof value === "string") {
      if (statuses[value]) return statuses[value];
      if (["startedAt", "completedAt", "archivedAt"].includes(key))
        return timestamp(value);
      if (key === "dueDate") return date(value, locale);
      return value;
    }
    if (typeof value === "object" && "name" in value)
      return String(
        value.name || ("email" in value ? value.email : "") || t("deletedUser"),
      );
    return JSON.stringify(value);
  };
  const changed = Object.keys(fieldNames)
    .filter(
      (key) =>
        (activity.before && Object.hasOwn(activity.before, key)) ||
        (activity.after && Object.hasOwn(activity.after, key)),
    )
    .filter(
      (key) =>
        JSON.stringify(activity.before?.[key]) !==
        JSON.stringify(activity.after?.[key]),
    )
    .filter(
      (key) =>
        key !== "assigneeId" ||
        !(activity.before?.assignee || activity.after?.assignee),
    );
  return (
    <li>
      <div className={styles.timelineHeader}>
        <strong>
          {names[activity.action.replace(/^OFFICE_WORK_/, "")] ||
            t("statusChanged")}
        </strong>
        <time dateTime={activity.createdAt}>
          {timestamp(activity.createdAt)}
        </time>
      </div>
      <OfficeWorkPersonLabel person={activity.actor} />
      {activity.reason && (
        <p>
          <strong>{t("reason")}: </strong>
          {activity.reason}
        </p>
      )}
      {changed.length > 0 && (
        <dl className={styles.changes}>
          {changed.map((key) => (
            <div key={key}>
              <dt>{fieldNames[key]}</dt>
              <dd>
                {activity.before ? (
                  <>
                    {t("activityBefore")}:{" "}
                    {valueLabel(activity.before[key], key)}
                    <br />
                  </>
                ) : null}
                {t("activityAfter")}: {valueLabel(activity.after?.[key], key)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

export function OfficeWorkDetail({
  id,
  timezone,
  busy,
  blocked,
  error,
  close,
  onEdit,
  onReassign,
  onAction,
  onRefreshed,
}: {
  id: string;
  timezone: string;
  busy: boolean;
  blocked: boolean;
  error: string;
  close: () => void;
  onEdit: (task: OfficeWorkTaskDTO) => void;
  onReassign: (task: OfficeWorkTaskDTO) => void;
  onAction: (task: OfficeWorkTaskDTO, action: OfficeWorkAction) => void;
  onRefreshed: () => void;
}) {
  const t = useTranslations("officeWork");
  const locale = useLocale();
  const [page, setPage] = useState(1);
  const result = useOfficeWorkTaskQuery(
    { id, page, pageSize: 20 },
    useFreshness(true),
  );
  const view = useQueryView(result);
  // Never retain a previous assignee's cached detail after an access/404 response.
  const data = result.error ? undefined : view.data;
  const task = data?.task;
  const timestamp = (value: string | null) =>
    value
      ? new Date(value).toLocaleString(locale, { timeZone: timezone })
      : "—";
  async function refresh() {
    try {
      await view.refresh().unwrap();
      onRefreshed();
    } catch {
      /* Keep mutation locks until an authoritative read succeeds. */
    }
  }
  return (
    <Modal title={task?.title || t("details")} close={() => !busy && close()}>
      <div className={styles.detail}>
        <ErrorNotice
          message={result.error ? t("taskUnavailable") : error}
          notify={false}
        />
        <div className="buttons">
          <button
            className="button small secondary"
            disabled={busy || view.isFetching}
            onClick={() => void refresh()}
          >
            {t("refreshTask")}
          </button>
          {view.isFetching && (
            <span className={styles.subtle} role="status">
              {t("loadingDetails")}
            </span>
          )}
        </div>
        {view.loading && <Loading />}
        {task && (
          <>
            <OfficeWorkBadges task={task} />
            {task.archivedAt && (
              <p className={styles.alert}>{t("archiveNote")}</p>
            )}
            <OfficeWorkActions
              task={task}
              disabled={busy || blocked || view.isFetching}
              onEdit={onEdit}
              onReassign={onReassign}
              onAction={onAction}
            />
            {task.description && (
              <div className={styles.description}>{task.description}</div>
            )}
            <dl className={styles.detailList}>
              <div>
                <dt>{t("assignee")}</dt>
                <dd>
                  <OfficeWorkPersonLabel person={task.assignee} />
                </dd>
              </div>
              <div>
                <dt>{t("creator")}</dt>
                <dd>
                  <OfficeWorkPersonLabel person={task.createdBy} />
                </dd>
              </div>
              <div>
                <dt>{t("dueDate")}</dt>
                <dd>
                  {task.dueDate ? date(task.dueDate, locale) : t("noDueDate")}
                </dd>
              </div>
              <div>
                <dt>{t("startedAt")}</dt>
                <dd>{timestamp(task.startedAt)}</dd>
              </div>
              <div>
                <dt>{t("completedAt")}</dt>
                <dd>{timestamp(task.completedAt)}</dd>
              </div>
              <div>
                <dt>{t("createdAt")}</dt>
                <dd>{timestamp(task.createdAt)}</dd>
              </div>
              <div>
                <dt>{t("updatedAt")}</dt>
                <dd>{timestamp(task.updatedAt)}</dd>
              </div>
              {task.archivedAt && (
                <div>
                  <dt>{t("archivedAt")}</dt>
                  <dd>{timestamp(task.archivedAt)}</dd>
                </div>
              )}
            </dl>
            <section aria-labelledby="office-work-activity">
              <h3 id="office-work-activity">{t("activity")}</h3>
              {data.activities.length ? (
                <ol className={styles.timeline}>
                  {data.activities.map((activity) => (
                    <OfficeWorkActivity
                      key={activity.id}
                      activity={activity}
                      timezone={timezone}
                    />
                  ))}
                </ol>
              ) : (
                <p className={styles.subtle}>{t("noActivity")}</p>
              )}
              {data.activityTotal > 20 && (
                <Pagination
                  page={data.activityPage}
                  pageSize={data.activityPageSize}
                  total={data.activityTotal}
                  loading={busy || view.isFetching}
                  onPage={setPage}
                />
              )}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
