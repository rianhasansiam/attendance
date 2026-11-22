"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ClipboardList, Plus } from "lucide-react";
import { confirmAction, promptAction } from "@/lib/client/alerts";
import { pageFromSearch, useUrlFilters } from "@/lib/client/use-url-filters";
import { isApiError } from "@/store/api/errors";
import { useFreshness } from "@/store/freshness";
import { useQueryView } from "@/store/use-query-view";
import {
  useActOnOfficeWorkMutation,
  useCreateOfficeWorkMutation,
  useOfficeWorkQuery,
  useUpdateOfficeWorkMutation,
} from "@/store/features/office-work/api";
import type {
  OfficeWorkListInput,
  OfficeWorkPriority,
  OfficeWorkTaskDTO,
} from "@/modules/office-work/contracts";
import {
  OfficeWorkActions,
  OfficeWorkBadges,
  OfficeWorkDetail,
  OfficeWorkPersonLabel,
  type OfficeWorkAction,
} from "./office-work-detail";
import { OfficeWorkForm, type OfficeWorkFormValues } from "./office-work-form";
import {
  date,
  Empty,
  ErrorNotice,
  Loading,
  Notice,
  PageHeader,
  Pagination,
} from "./ui";
import styles from "./office-work-workspace.module.css";

const statuses = ["PENDING", "PROCESSING", "DONE"] as const;
const priorities = ["LOW", "MEDIUM", "HIGH"] as const;
const listFilters = ["overdue", "due-today", "high-priority"] as const;
const sorts = ["newest", "oldest", "dueDate", "priority", "updated"] as const;
const archiveOptions = ["active", "archived", "all"] as const;

export function OfficeWorkWorkspace({
  role,
}: {
  role: "SUPER_ADMIN" | "MANAGE_DRIVER" | "EMPLOYEE";
}) {
  const t = useTranslations("officeWork");
  const locale = useLocale();
  const management = role !== "EMPLOYEE";
  const { params, update } = useUrlFilters();
  const page = pageFromSearch(params.get("page"));
  const view =
    role === "EMPLOYEE" || params.get("view") === "mine" ? "mine" : "all";
  const status = statuses.find((value) => value === params.get("status"));
  const listFilter = listFilters.find(
    (value) => value === params.get("listFilter"),
  );
  const pageSize =
    [20, 50, 100].find((value) => String(value) === params.get("pageSize")) ??
    20;
  const filters = {
    search: params.get("search") || "",
    assigneeId: management ? params.get("assigneeId") || "" : "",
    createdById: management ? params.get("createdById") || "" : "",
    priority:
      priorities.find((value) => value === params.get("priority")) || "",
    from: params.get("from") || "",
    to: params.get("to") || "",
    sort: sorts.find((value) => value === params.get("sort")) ?? "newest",
    archived:
      archiveOptions.find((value) => value === params.get("archived")) ??
      "active",
  };
  const filterKey = JSON.stringify(filters);
  const [edited, setEdited] = useState<{
    key: string;
    value: typeof filters;
  }>();
  const draft = edited?.key === filterKey ? edited.value : filters;
  function changeFilter(patch: Partial<typeof filters>) {
    setEdited({ key: filterKey, value: { ...draft, ...patch } });
  }
  const query: OfficeWorkListInput = {
    view,
    page,
    pageSize,
    sort: filters.sort,
    archived: filters.archived,
    ...(status ? { status } : {}),
    ...(listFilter ? { listFilter } : {}),
    ...(filters.search ? { search: filters.search } : {}),
    ...(filters.priority
      ? { priority: filters.priority as OfficeWorkPriority }
      : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
    ...(management && filters.assigneeId
      ? { assigneeId: filters.assigneeId }
      : {}),
    ...(management && filters.createdById
      ? { createdById: filters.createdById }
      : {}),
  };
  const result = useOfficeWorkQuery(query, useFreshness(true));
  const overview = useQueryView(result);
  const data = overview.data;
  const [createTask] = useCreateOfficeWorkMutation();
  const [updateTask] = useUpdateOfficeWorkMutation();
  const [actOnTask] = useActOnOfficeWorkMutation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{
    task?: OfficeWorkTaskDTO;
    reassignOnly?: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const [filterError, setFilterError] = useState("");
  const submitting = useRef(false);
  const active = useRef(true);
  const generation = useRef(0);
  useEffect(() => {
    active.current = true;
    const startedGeneration = generation.current;
    return () => {
      active.current = false;
      generation.current = startedGeneration + 1;
      // Next's Activity may hide and restore this workspace without discarding
      // state. Fence the abandoned promise and reconcile its outcome on reveal.
      if (submitting.current) {
        setBlocked(true);
        setEditor(null);
      }
      submitting.current = false;
      setBusy(false);
    };
  }, []);
  const disabled = busy || blocked || overview.isFetching || !!overview.error;
  const actionLabels = {
    start: t("start"),
    complete: t("complete"),
    reopen: t("reopen"),
    archive: t("archive"),
  };
  const statusLabels = {
    PENDING: t("pending"),
    PROCESSING: t("processing"),
    DONE: t("done"),
  };
  const listLabels = {
    overdue: t("overdue"),
    "due-today": t("dueToday"),
    "high-priority": t("highUnfinished"),
  };
  const activeListLabel =
    [
      status ? statusLabels[status] : "",
      listFilter ? listLabels[listFilter] : "",
    ]
      .filter(Boolean)
      .join(" · ") || t("allTasks");
  const hasFilters = !!(
    filters.search ||
    filters.assigneeId ||
    filters.createdById ||
    filters.priority ||
    filters.from ||
    filters.to ||
    status ||
    listFilter ||
    filters.archived !== "active"
  );

  function clearFilters() {
    setFilterError("");
    update({
      search: null,
      assigneeId: null,
      createdById: null,
      priority: null,
      from: null,
      to: null,
      status: null,
      listFilter: null,
      archived: null,
      page: null,
      sort: null,
    });
  }
  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (draft.from && draft.to && draft.from > draft.to) {
      setFilterError(t("invalidRange"));
      return;
    }
    setFilterError("");
    update({ ...draft, search: draft.search.trim(), page: null });
  }
  async function refresh() {
    if (busy) return;
    try {
      await overview.refresh().unwrap();
      if (active.current) {
        setBlocked(false);
        setActionError("");
        setEditor(null);
      }
    } catch {
      /* Existing error UI offers retry. */
    }
  }
  function onEdit(task: OfficeWorkTaskDTO) {
    setActionError("");
    setEditor({ task });
  }
  function onReassign(task: OfficeWorkTaskDTO) {
    setActionError("");
    setEditor({ task, reassignOnly: true });
  }
  function fail(error: unknown) {
    const uncertain =
      isApiError(error) &&
      (error.status === 409 || typeof error.status === "string");
    const errors: Record<string, string> = {
      TASK_CONFLICT: t("conflict"),
      INVALID_TASK_TRANSITION: t("conflict"),
      TASK_ARCHIVED: t("archiveNote"),
      INVALID_ASSIGNEE: t("assigneeInvalid"),
      OVERRIDE_REASON_REQUIRED: t("requiredReason"),
      REOPEN_REASON_REQUIRED: t("requiredReason"),
      REASSIGN_CONFIRMATION_REQUIRED: t("reassignWarning"),
      IDEMPOTENCY_CONFLICT: t("conflict"),
      VALIDATION_ERROR: t("validationFailed"),
      NOT_FOUND: t("taskUnavailable"),
    };
    setActionError(
      (isApiError(error) ? errors[error.code] : undefined) ||
        (uncertain ? t("conflict") : t("actionFailed")),
    );
    setBlocked(true);
  }
  async function perform(task: OfficeWorkTaskDTO, action: OfficeWorkAction) {
    if (submitting.current || disabled) return;
    submitting.current = true;
    setBusy(true);
    setActionError("");
    setMessage("");
    const started = generation.current;
    const current = () => active.current && started === generation.current;
    try {
      let reason: string | undefined;
      if (
        action === "reopen" ||
        ((action === "start" || action === "complete") &&
          task.permissions.requiresOverrideReason)
      ) {
        const entered = await promptAction({
          title: actionLabels[action],
          inputLabel:
            action === "reopen" ? t("reopenReason") : t("overrideReason"),
          text: action === "reopen" ? t("reasonHint") : t("overrideNote"),
          required: true,
          maxLength: 1000,
          confirmText: actionLabels[action],
        });
        if (entered === null || !current()) return;
        reason = entered.trim();
      }
      if (action === "archive") {
        const confirmed = await confirmAction({
          title: t("archiveConfirm"),
          text: t("archiveDescription"),
          confirmText: t("archive"),
          danger: true,
        });
        if (!confirmed || !current()) return;
      }
      await actOnTask({
        id: task.id,
        input:
          action === "reopen"
            ? { action, expectedVersion: task.version, reason: reason! }
            : action === "archive"
              ? { action, expectedVersion: task.version }
              : {
                  action,
                  expectedVersion: task.version,
                  ...(reason ? { reason } : {}),
                },
      }).unwrap();
      if (current())
        setMessage(action === "archive" ? t("archived") : t("saved"));
    } catch (error) {
      if (current()) fail(error);
    } finally {
      if (current()) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }
  async function addWorkUpdate(
    task: OfficeWorkTaskDTO,
    text: string,
  ): Promise<boolean> {
    const update = text.trim();
    if (
      submitting.current ||
      disabled ||
      !task.permissions.canAddUpdate ||
      !update ||
      update.length > 10000
    )
      return false;
    submitting.current = true;
    setBusy(true);
    setActionError("");
    setMessage("");
    const started = generation.current;
    const current = () => active.current && started === generation.current;
    try {
      await actOnTask({
        id: task.id,
        input: { action: "add-update", expectedVersion: task.version, update },
      }).unwrap();
      if (!current()) return false;
      setMessage(t("updateSaved"));
      return true;
    } catch (error) {
      if (current()) fail(error);
      return false;
    } finally {
      if (current()) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }
  async function save(values: OfficeWorkFormValues, requestId: string) {
    if (submitting.current || !editor || blocked) return;
    submitting.current = true;
    setBusy(true);
    setActionError("");
    setMessage("");
    const started = generation.current;
    const current = () => active.current && started === generation.current;
    try {
      if (editor.reassignOnly && editor.task) {
        const reset = editor.task.status !== "PENDING";
        const confirmed = await confirmAction({
          title: reset ? t("reassignConfirm") : t("reassignPendingConfirm"),
          text: reset ? t("reassignWarning") : t("reassignPendingText"),
          confirmText: t("reassign"),
          danger: reset,
        });
        if (!confirmed || !current()) return;
        await actOnTask({
          id: editor.task.id,
          input: {
            action: "reassign",
            expectedVersion: editor.task.version,
            assigneeId: values.assigneeId,
            confirmReset: reset,
          },
        }).unwrap();
      } else if (editor.task) {
        const { title, description, priority, dueDate } = values;
        await updateTask({
          id: editor.task.id,
          input: {
            title,
            description,
            priority,
            dueDate,
            expectedVersion: editor.task.version,
          },
        }).unwrap();
      } else {
        await createTask({ ...values, requestId }).unwrap();
      }
      if (current()) {
        setMessage(editor.task ? t("saved") : t("created"));
        setEditor(null);
      }
    } catch (error) {
      if (current()) fail(error);
    } finally {
      if (current()) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }
  function create() {
    setActionError("");
    setEditor({});
  }
  function listOnly(filter: { status?: string; listFilter?: string }) {
    update({
      status: filter.status ?? null,
      listFilter: filter.listFilter ?? null,
      page: null,
    });
  }
  const statCards = [
    {
      key: "total",
      label: t("total"),
      value: data?.dashboard.total,
      selected: !status && !listFilter,
      filter: {},
    },
    {
      key: "pending",
      label: t("pending"),
      value: data?.dashboard.pending,
      selected: status === "PENDING" && !listFilter,
      filter: { status: "PENDING" },
    },
    {
      key: "processing",
      label: t("processing"),
      value: data?.dashboard.processing,
      selected: status === "PROCESSING" && !listFilter,
      filter: { status: "PROCESSING" },
    },
    {
      key: "done",
      label: t("done"),
      value: data?.dashboard.done,
      selected: status === "DONE" && !listFilter,
      filter: { status: "DONE" },
    },
    {
      key: "overdue",
      label: t("overdue"),
      value: data?.dashboard.overdue,
      selected: listFilter === "overdue" && !status,
      filter: { listFilter: "overdue" },
    },
    {
      key: "dueToday",
      label: t("dueToday"),
      value: data?.dashboard.dueToday,
      selected: listFilter === "due-today" && !status,
      filter: { listFilter: "due-today" },
    },
  ];
  function taskActions(task: OfficeWorkTaskDTO) {
    return (
      <OfficeWorkActions
        task={task}
        disabled={disabled}
        onEdit={onEdit}
        onReassign={onReassign}
        onAction={(task, action) => void perform(task, action)}
      />
    );
  }

  return (
    <div className={styles.workspace}>
      <PageHeader
        eyebrow={t("eyebrow")}
        title={t("title")}
        description={management ? t("description") : t("myDescription")}
        action={
          <div className="buttons">
            <button
              className="button secondary"
              disabled={busy || overview.isFetching}
              onClick={() => void refresh()}
            >
              {t("refresh")}
            </button>
            {management && (
              <button className="button" disabled={disabled} onClick={create}>
                <Plus size={16} />
                {t("create")}
              </button>
            )}
          </div>
        }
      />
      <ErrorNotice
        message={
          overview.error
            ? t("error")
            : !editor && !selectedId
              ? actionError
              : ""
        }
      />
      {overview.error && (
        <button
          className="button secondary"
          onClick={() => void refresh()}
          disabled={overview.isFetching}
        >
          {t("retry")}
        </button>
      )}
      {blocked && (
        <div className={styles.alert} role="alert">
          <p>{t("conflict")}</p>
          <button
            className="button small secondary"
            disabled={busy || overview.isFetching}
            onClick={() => void refresh()}
          >
            {t("refresh")}
          </button>
        </div>
      )}
      {message && <Notice notify>{message}</Notice>}
      {management && (
        <div className={styles.scope} aria-label={t("title")}>
          <button
            className={`button small ${view === "all" ? "" : "secondary"}`}
            aria-pressed={view === "all"}
            disabled={busy}
            onClick={() =>
              update({ view: "all", assigneeId: null, page: null })
            }
          >
            {t("allWork")}
          </button>
          <button
            className={`button small ${view === "mine" ? "" : "secondary"}`}
            aria-pressed={view === "mine"}
            disabled={busy}
            onClick={() =>
              update({ view: "mine", assigneeId: null, page: null })
            }
          >
            {t("myWork")}
          </button>
        </div>
      )}
      <section
        aria-label={t("activeScope")}
        className={styles.stats}
        aria-busy={overview.loading}
      >
        {statCards.map((card) => (
          <button
            type="button"
            key={card.key}
            className={styles.stat}
            disabled={busy || !data}
            aria-pressed={card.selected}
            aria-label={
              card.key === "total"
                ? t("totalHint")
                : t("cardHint", { label: card.label })
            }
            onClick={() => listOnly(card.filter)}
          >
            <span>{card.label}</span>
            <strong>
              {card.value === undefined
                ? "—"
                : card.value.toLocaleString(locale)}
            </strong>
          </button>
        ))}
      </section>
      <div className={styles.overview}>
        <div className={styles.completion}>
          <strong>
            {t("completion")}:{" "}
            {data
              ? `${data.dashboard.completionPercent.toLocaleString(locale, { maximumFractionDigits: 1 })}%`
              : "—"}
          </strong>
          <small>{t("completionNote")}</small>
          {data && (
            <small>
              {t("businessDate", {
                date: date(data.today, locale),
                timezone: data.timezone,
              })}
            </small>
          )}
        </div>
        <button
          className="button secondary"
          disabled={busy || !data}
          aria-pressed={listFilter === "high-priority"}
          onClick={() => listOnly({ listFilter: "high-priority" })}
        >
          {t("unfinishedHigh")} {data ? `(${data.dashboard.highPriority})` : ""}
        </button>
      </div>
      <section className="card">
        <form className={`card-body ${styles.form}`} onSubmit={applyFilters}>
          <div className={styles.filters}>
            <div className="field">
              <label htmlFor="work-search">{t("search")}</label>
              <input
                id="work-search"
                type="search"
                maxLength={200}
                placeholder={t("searchPlaceholder")}
                value={draft.search}
                disabled={busy}
                onChange={(event) =>
                  changeFilter({ search: event.target.value })
                }
              />
            </div>
            {management && (
              <>
                <div className="field">
                  <label htmlFor="work-assignee-filter">{t("assignee")}</label>
                  <select
                    id="work-assignee-filter"
                    value={draft.assigneeId}
                    disabled={busy || view === "mine"}
                    onChange={(event) =>
                      changeFilter({ assigneeId: event.target.value })
                    }
                  >
                    <option value="">{t("allAssignees")}</option>
                    {draft.assigneeId &&
                      !data?.assignees.some(
                        (person) => person.id === draft.assigneeId,
                      ) && (
                        <option value={draft.assigneeId}>
                          {t("currentSelection")}
                        </option>
                      )}
                    {data?.assignees.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name || person.email}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="work-creator-filter">{t("creator")}</label>
                  <select
                    id="work-creator-filter"
                    value={draft.createdById}
                    disabled={busy}
                    onChange={(event) =>
                      changeFilter({ createdById: event.target.value })
                    }
                  >
                    <option value="">{t("allCreators")}</option>
                    {draft.createdById &&
                      !data?.creators.some(
                        (person) => person.id === draft.createdById,
                      ) && (
                        <option value={draft.createdById}>
                          {t("currentSelection")}
                        </option>
                      )}
                    {data?.creators.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name || person.email}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
            <div className="field">
              <label htmlFor="work-priority-filter">{t("priority")}</label>
              <select
                id="work-priority-filter"
                value={draft.priority}
                disabled={busy}
                onChange={(event) =>
                  changeFilter({
                    priority: event.target.value as typeof filters.priority,
                  })
                }
              >
                <option value="">{t("allPriorities")}</option>
                <option value="LOW">{t("low")}</option>
                <option value="MEDIUM">{t("medium")}</option>
                <option value="HIGH">{t("high")}</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="work-date-from">{t("dueFrom")}</label>
              <input
                id="work-date-from"
                type="date"
                value={draft.from}
                disabled={busy}
                onChange={(event) => changeFilter({ from: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="work-date-to">{t("dueTo")}</label>
              <input
                id="work-date-to"
                type="date"
                value={draft.to}
                min={draft.from || undefined}
                disabled={busy}
                onChange={(event) => changeFilter({ to: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="work-sort">{t("sort")}</label>
              <select
                id="work-sort"
                value={draft.sort}
                disabled={busy}
                onChange={(event) =>
                  changeFilter({
                    sort: event.target.value as typeof filters.sort,
                  })
                }
              >
                <option value="newest">{t("newest")}</option>
                <option value="oldest">{t("oldest")}</option>
                <option value="updated">{t("updated")}</option>
                <option value="dueDate">{t("dueSoon")}</option>
                <option value="priority">{t("prioritySort")}</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="work-archive">{t("archivedFilter")}</label>
              <select
                id="work-archive"
                value={draft.archived}
                disabled={busy}
                onChange={(event) =>
                  changeFilter({
                    archived: event.target.value as typeof filters.archived,
                  })
                }
              >
                <option value="active">{t("activeTasks")}</option>
                <option value="archived">{t("archivedTasks")}</option>
                <option value="all">{t("includeArchived")}</option>
              </select>
            </div>
          </div>
          <ErrorNotice message={filterError} notify={false} />
          <div className="buttons">
            <button type="submit" className="button secondary" disabled={busy}>
              {t("apply")}
            </button>
            {hasFilters && (
              <button
                type="button"
                className="button small secondary"
                disabled={busy}
                onClick={clearFilters}
              >
                {t("clear")}
              </button>
            )}
            {overview.isFetching && data && (
              <span className={styles.subtle} role="status">
                {t("working")}
              </span>
            )}
          </div>
        </form>
      </section>
      {filters.archived !== "active" && (
        <p className={styles.alert}>{t("archiveNote")}</p>
      )}
      <section
        className="card"
        aria-busy={overview.isFetching}
        aria-label={t("title")}
      >
        <div className={`card-header ${styles.listHeader}`}>
          <div>
            <h2>{t("activeFilter", { filter: activeListLabel })}</h2>
            <p className={styles.subtle}>{t("listDescription")}</p>
          </div>
          {(status || listFilter) && (
            <button
              className="button small secondary"
              disabled={busy}
              onClick={() => listOnly({})}
            >
              {t("resetList")}
            </button>
          )}
        </div>
        {overview.loading ? (
          <Loading />
        ) : (
          data &&
          (data.items.length ? (
            <>
              <div className={`${styles.desktop} table-scroll`}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>{t("titleLabel")}</th>
                      {management && <th>{t("assignee")}</th>}
                      <th>
                        {t("status")} / {t("priority")}
                      </th>
                      <th>{t("dueDate")}</th>
                      {management && <th>{t("creator")}</th>}
                      <th>{t("actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((task) => (
                      <tr key={task.id}>
                        <td>
                          <button
                            className={styles.title}
                            disabled={busy}
                            onClick={() => {
                              setActionError("");
                              setSelectedId(task.id);
                            }}
                          >
                            {task.title}
                          </button>
                        </td>
                        {management && (
                          <td>
                            <OfficeWorkPersonLabel person={task.assignee} />
                          </td>
                        )}
                        <td>
                          <OfficeWorkBadges task={task} />
                        </td>
                        <td>
                          {task.dueDate
                            ? date(task.dueDate, locale)
                            : t("noDueDate")}
                        </td>
                        {management && (
                          <td>
                            <OfficeWorkPersonLabel person={task.createdBy} />
                          </td>
                        )}
                        <td>
                          <div className={styles.actionButtons}>
                            <button
                              className="button small secondary"
                              disabled={busy}
                              onClick={() => {
                                setActionError("");
                                setSelectedId(task.id);
                              }}
                            >
                              {t("details")}
                            </button>
                            {taskActions(task)}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className={styles.mobile}>
                {data.items.map((task) => (
                  <article key={task.id} className={styles.taskCard}>
                    <h3>
                      <button
                        className={styles.title}
                        disabled={busy}
                        onClick={() => {
                          setActionError("");
                          setSelectedId(task.id);
                        }}
                      >
                        {task.title}
                      </button>
                    </h3>
                    <OfficeWorkBadges task={task} />
                    <dl>
                      {management && (
                        <div>
                          <dt>{t("assignee")}</dt>
                          <dd>
                            <OfficeWorkPersonLabel person={task.assignee} />
                          </dd>
                        </div>
                      )}
                      <div>
                        <dt>{t("dueDate")}</dt>
                        <dd>
                          {task.dueDate
                            ? date(task.dueDate, locale)
                            : t("noDueDate")}
                        </dd>
                      </div>
                      {management && (
                        <div>
                          <dt>{t("creator")}</dt>
                          <dd>
                            <OfficeWorkPersonLabel person={task.createdBy} />
                          </dd>
                        </div>
                      )}
                    </dl>
                    <div className={styles.actionButtons}>
                      <button
                        className="button small secondary"
                        disabled={busy}
                        onClick={() => {
                          setActionError("");
                          setSelectedId(task.id);
                        }}
                      >
                        {t("details")}
                      </button>
                      {taskActions(task)}
                    </div>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <>
              <Empty
                title={
                  data.total > 0
                    ? t("emptyPage")
                    : hasFilters
                      ? t("noMatches")
                      : management
                        ? t("emptyManagement")
                        : t("emptyEmployee")
                }
                description={
                  data.total > 0
                    ? t("emptyPageDescription")
                    : hasFilters
                      ? t("noMatchesDescription")
                      : management
                        ? t("emptyManagementDescription")
                        : t("emptyEmployeeDescription")
                }
              />
              <div className={styles.emptyActions}>
                {data.total > 0 ? (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => update({ page: null })}
                  >
                    {t("firstPage")}
                  </button>
                ) : hasFilters ? (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={clearFilters}
                  >
                    {t("clear")}
                  </button>
                ) : (
                  management && (
                    <button
                      className="button"
                      disabled={disabled}
                      onClick={create}
                    >
                      <Plus size={16} />
                      {t("create")}
                    </button>
                  )
                )}
              </div>
            </>
          ))
        )}
        {data && (
          <>
            <div className="card-body">
              <div className="field">
                <label htmlFor="work-page-size">{t("pageSize")}</label>
                <select
                  id="work-page-size"
                  value={pageSize}
                  disabled={busy}
                  onChange={(event) =>
                    update({ pageSize: event.target.value, page: null })
                  }
                >
                  {[20, 50, 100].map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <Pagination
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              loading={busy || overview.isFetching}
              onPage={(page) => update({ page })}
            />
          </>
        )}
      </section>
      {management && data && (
        <section className="card">
          <div className="card-header">
            <h2>{t("workload")}</h2>
            <p className={styles.subtle}>{t("workloadDescription")}</p>
          </div>
          {data.workload.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t("assignee")}</th>
                    <th>{t("pending")}</th>
                    <th>{t("processing")}</th>
                    <th>{t("done")}</th>
                    <th>{t("overdue")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.workload.map((row, index) => (
                    <tr key={row.assignee?.id ?? `deleted-${index}`}>
                      <td>
                        <OfficeWorkPersonLabel person={row.assignee} />
                      </td>
                      <td>{row.pending}</td>
                      <td>{row.processing}</td>
                      <td>{row.done}</td>
                      <td>{row.overdue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card-body">
              <ClipboardList size={20} />
              <p className="muted">{t("noWorkload")}</p>
            </div>
          )}
        </section>
      )}
      {selectedId && !editor && (
        <OfficeWorkDetail
          key={selectedId}
          id={selectedId}
          timezone={data?.timezone ?? "Asia/Dhaka"}
          busy={busy}
          blocked={blocked}
          error={actionError}
          close={() => {
            setSelectedId(null);
            setActionError("");
          }}
          onEdit={onEdit}
          onReassign={onReassign}
          onAction={(task, action) => void perform(task, action)}
          onAddUpdate={addWorkUpdate}
          onRefreshed={() => {
            setBlocked(false);
            setActionError("");
          }}
        />
      )}
      {editor && (
        <OfficeWorkForm
          key={`${editor.task?.id ?? "new"}-${editor.reassignOnly ? "reassign" : "edit"}`}
          task={editor.task}
          reassignOnly={editor.reassignOnly}
          busy={busy}
          blocked={blocked}
          error={actionError}
          close={() => {
            setEditor(null);
            setActionError("");
          }}
          submit={save}
          refresh={() => void refresh()}
        />
      )}
    </div>
  );
}
