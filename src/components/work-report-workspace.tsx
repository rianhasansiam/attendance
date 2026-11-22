"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { confirmAction } from "@/lib/client/alerts";
import { useDebouncedValue } from "@/lib/client/use-debounced-value";
import { pageFromSearch, useUrlFilters } from "@/lib/client/use-url-filters";
import type {
  WorkReportDTO,
  WorkReportListInput,
} from "@/modules/work-report/contracts";
import { isApiError } from "@/store/api/errors";
import { useFreshness } from "@/store/freshness";
import { useQueryView } from "@/store/use-query-view";
import {
  useCreateWorkReportMutation,
  useDeleteWorkReportMutation,
  useLazyWorkReportQuery,
  useUpdateWorkReportMutation,
  useWorkReportAuthorsQuery,
  useWorkReportFeedQuery,
} from "@/store/features/work-report/api";
import { WorkReportCard } from "./work-report-card";
import { WorkReportForm, type WorkReportFormValues } from "./work-report-form";
import {
  date,
  Empty,
  ErrorNotice,
  Loading,
  Notice,
  PageHeader,
  Pagination,
} from "./ui";
import styles from "./work-report-workspace.module.css";

export function WorkReportAuthorFilter({
  value,
  date: workDate,
  disabled,
  onChange,
}: {
  value: string;
  date?: string;
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const t = useTranslations("workReport");
  const [search, setSearch] = useState("");
  const debounced = useDebouncedValue(search).trim();
  const query = useWorkReportAuthorsQuery(
    {
      ...(debounced ? { search: debounced } : {}),
      ...(workDate ? { date: workDate } : {}),
    },
    useFreshness(),
  );
  const view = useQueryView(query);
  return (
    <div className={`field ${styles.authorFilter}`}>
      <label htmlFor="report-author-search">{t("searchAuthors")}</label>
      <input
        id="report-author-search"
        type="search"
        maxLength={200}
        value={search}
        disabled={disabled}
        onChange={(event) => setSearch(event.target.value)}
      />
      <label htmlFor="report-author">{t("author")}</label>
      <select
        id="report-author"
        value={value}
        disabled={disabled || view.loading || !!view.error}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{t("allAuthors")}</option>
        {value && !view.data?.some((author) => author.id === value) && (
          <option value={value}>{t("currentAuthor")}</option>
        )}
        {view.data?.map((author) => (
          <option key={author.id} value={author.id}>
            {author.name?.trim() || t("teamMember")}
          </option>
        ))}
      </select>
      <small className={styles.caption}>{t("authorHint")}</small>
      {view.loading && (
        <span className={styles.caption} role="status">
          {t("loading")}
        </span>
      )}
      {view.data?.length === 0 && (
        <small className={styles.caption}>{t("noAuthors")}</small>
      )}
      {view.error && (
        <>
          <ErrorNotice message={t("authorsError")} notify={false} />
          <button
            type="button"
            className="button small secondary"
            onClick={() => void view.refresh()}
          >
            {t("retry")}
          </button>
        </>
      )}
    </div>
  );
}

export function WorkReportWorkspace() {
  const t = useTranslations("workReport");
  const locale = useLocale();
  const { params, update } = useUrlFilters();
  const selectedDate = params.get("date") || "";
  const mine = params.get("mine") === "true";
  const authorId = mine ? "" : params.get("authorId") || "";
  const search = params.get("search") || "";
  const page = pageFromSearch(params.get("page"));
  const pageSize =
    [20, 50, 100].find((size) => String(size) === params.get("pageSize")) ?? 20;
  const query: WorkReportListInput = {
    page,
    pageSize,
    mine,
    ...(selectedDate ? { date: selectedDate } : {}),
    ...(authorId ? { authorId } : {}),
    ...(search ? { search } : {}),
  };
  const result = useWorkReportFeedQuery(query, useFreshness(true));
  const feed = useQueryView(result);
  const data = feed.data;
  const filters = { date: selectedDate || data?.date || "", authorId, search };
  const filterKey = JSON.stringify(filters);
  const [draftFilters, setDraftFilters] = useState<{
    key: string;
    value: typeof filters;
  }>();
  const draft = draftFilters?.key === filterKey ? draftFilters.value : filters;
  const changeFilter = (patch: Partial<typeof filters>) =>
    setDraftFilters({ key: filterKey, value: { ...draft, ...patch } });
  const [createReport] = useCreateWorkReportMutation();
  const [updateReport] = useUpdateWorkReportMutation();
  const [deleteReport] = useDeleteWorkReportMutation();
  const [readReport] = useLazyWorkReportQuery();
  const [editor, setEditor] = useState<{
    report: WorkReportDTO;
    revision: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [actionError, setActionError] = useState("");
  const [errorContext, setErrorContext] = useState<
    "composer" | "editor" | "delete" | null
  >(null);
  const [message, setMessage] = useState("");
  const [posted, setPosted] = useState(false);
  const submitting = useRef(false);
  const active = useRef(true);
  const generation = useRef(0);
  useEffect(() => {
    active.current = true;
    const started = generation.current;
    return () => {
      active.current = false;
      generation.current = started + 1;
      if (submitting.current) setBlocked(true);
      submitting.current = false;
      setBusy(false);
      setRefreshing(false);
    };
  }, []);
  const disabled =
    busy || refreshing || blocked || feed.isFetching || !!feed.error;
  const narrowing = !!(search || authorId || mine);
  const historical = !!data && data.date !== data.today;

  function fail(error: unknown, context: "composer" | "editor" | "delete") {
    const known = isApiError(error);
    const codes: Record<string, string> = {
      WORK_REPORT_CONFLICT: t("conflict"),
      REPORT_CONFLICT: t("conflict"),
      IDEMPOTENCY_CONFLICT: t("idempotencyConflict"),
      FORBIDDEN: t("forbidden"),
      NOT_FOUND: t("notFound"),
      VALIDATION_ERROR: t("validation"),
    };
    const uncertain =
      !known ||
      typeof error.status === "string" ||
      error.status === 409 ||
      error.status === 403 ||
      error.status === 404 ||
      error.status >= 500;
    setActionError(
      (known ? codes[error.code] : undefined) ||
        (uncertain
          ? t("conflict")
          : t(context === "delete" ? "deleteFailed" : "saveFailed")),
    );
    setErrorContext(context);
    setBlocked(uncertain);
  }
  async function refreshFeed() {
    if (busy || refreshing) return;
    setRefreshing(true);
    const started = generation.current;
    try {
      await feed.refresh().unwrap();
      if (active.current && started === generation.current && !editor) {
        setBlocked(false);
        setActionError("");
        setErrorContext(null);
      }
    } catch {
      /* The query error and retry action remain visible. */
    } finally {
      if (active.current && started === generation.current)
        setRefreshing(false);
    }
  }
  async function postReport(
    values: WorkReportFormValues,
    requestId: string,
  ): Promise<boolean> {
    if (submitting.current || disabled) return false;
    submitting.current = true;
    setBusy(true);
    setActionError("");
    setErrorContext(null);
    setMessage("");
    const started = generation.current;
    const current = () => active.current && started === generation.current;
    try {
      await createReport({ ...values, requestId }).unwrap();
      if (!current()) return false;
      setMessage(t("posted"));
      setPosted(true);
      return true;
    } catch (error) {
      if (current()) fail(error, "composer");
      return false;
    } finally {
      if (current()) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }
  async function editReport(values: WorkReportFormValues): Promise<boolean> {
    if (submitting.current || disabled || !editor) return false;
    const expected = editor.report;
    submitting.current = true;
    setBusy(true);
    setActionError("");
    setErrorContext(null);
    setMessage("");
    const started = generation.current;
    const current = () => active.current && started === generation.current;
    try {
      await updateReport({
        id: expected.id,
        input: { ...values, expectedVersion: expected.version },
      }).unwrap();
      if (!current()) return false;
      setMessage(t("editedSuccess"));
      setPosted(false);
      setEditor(null);
      return true;
    } catch (error) {
      if (current()) fail(error, "editor");
      return false;
    } finally {
      if (current()) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }
  async function removeReport(report: WorkReportDTO) {
    if (submitting.current || disabled || !report.permissions.canDelete) return;
    submitting.current = true;
    setBusy(true);
    setActionError("");
    setMessage("");
    setErrorContext(null);
    const started = generation.current;
    const current = () => active.current && started === generation.current;
    try {
      const confirmed = await confirmAction({
        title: t("deleteConfirm"),
        text: t("deleteDescription"),
        confirmText: t("delete"),
        danger: true,
      });
      if (!confirmed || !current()) return;
      await deleteReport({
        id: report.id,
        input: { expectedVersion: report.version },
      }).unwrap();
      if (current()) {
        setMessage(t("deletedSuccess"));
        setPosted(false);
      }
    } catch (error) {
      if (current()) fail(error, "delete");
    } finally {
      if (current()) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }
  async function reloadEditor() {
    if (submitting.current || busy || !editor) return;
    const expected = editor;
    submitting.current = true;
    setBusy(true);
    const started = generation.current;
    const current = () => active.current && started === generation.current;
    try {
      const confirmed = await confirmAction({
        title: t("discardConfirm"),
        text: t("reloadDescription"),
        confirmText: t("reloadLatest"),
        danger: true,
      });
      if (!confirmed || !current()) return;
      const latest = await readReport(expected.report.id, false).unwrap();
      if (!current()) return;
      setEditor({ report: latest, revision: expected.revision + 1 });
      setBlocked(false);
      setActionError("");
      setErrorContext(null);
    } catch (error) {
      if (current()) fail(error, "editor");
    } finally {
      if (current()) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }
  function edit(report: WorkReportDTO) {
    if (disabled || !report.permissions.canEdit) return;
    setEditor({ report, revision: 0 });
    setActionError("");
    setErrorContext(null);
  }
  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    update({
      date: draft.date === data?.today ? null : draft.date,
      authorId: mine ? null : draft.authorId,
      search: draft.search.trim(),
      page: null,
    });
  }
  function clearFilters() {
    update({ authorId: null, search: null, mine: null, page: null });
  }
  function today() {
    update({
      date: null,
      authorId: null,
      search: null,
      mine: null,
      page: null,
    });
  }

  return (
    <div className={styles.workspace}>
      <PageHeader
        eyebrow={t("eyebrow")}
        title={t("title")}
        description={t("description")}
        action={
          <button
            className="button secondary"
            disabled={busy || refreshing || feed.isFetching}
            onClick={() => void refreshFeed()}
          >
            {refreshing ? t("refreshing") : t("refresh")}
          </button>
        }
      />
      <ErrorNotice
        message={
          feed.error ? t("error") : errorContext === "delete" ? actionError : ""
        }
      />
      {feed.error && (
        <button
          className="button secondary"
          disabled={busy || refreshing}
          onClick={() => void refreshFeed()}
        >
          {t("retry")}
        </button>
      )}
      {message && (
        <Notice notify>
          {message}
          {posted && (
            <>
              {" "}
              <button
                type="button"
                className="button small secondary"
                disabled={busy}
                onClick={today}
              >
                {t("viewToday")}
              </button>
            </>
          )}
        </Notice>
      )}
      {blocked && errorContext !== "editor" && (
        <div className={styles.reconcile} role="alert">
          <p>{t("conflict")}</p>
          <button
            className="button small secondary"
            disabled={busy || refreshing}
            onClick={() => void refreshFeed()}
          >
            {t("refresh")}
          </button>
        </div>
      )}
      {historical && (
        <div className={styles.dateNotice}>
          {t("historicalNotice", { date: date(data.date, locale) })}
          <button
            type="button"
            className="button small secondary"
            disabled={busy}
            onClick={today}
          >
            {t("today")}
          </button>
        </div>
      )}
      <WorkReportForm
        today={data?.today}
        timezone={data?.timezone ?? "Asia/Dhaka"}
        busy={busy || refreshing}
        blocked={blocked}
        submitDisabled={feed.isFetching || !!feed.error}
        error={errorContext === "composer" ? actionError : ""}
        onSave={postReport}
        onRefresh={() => void refreshFeed()}
        onClear={() => {
          setActionError("");
          setErrorContext(null);
        }}
      />
      <section className="card">
        <form className="card-body" onSubmit={applyFilters}>
          <div className={styles.filters}>
            <div className="field">
              <label htmlFor="report-date">{t("date")}</label>
              <input
                id="report-date"
                type="date"
                value={draft.date}
                disabled={busy}
                onChange={(event) => changeFilter({ date: event.target.value })}
              />
            </div>
            <WorkReportAuthorFilter
              value={draft.authorId}
              date={draft.date || undefined}
              disabled={busy || mine}
              onChange={(authorId) => changeFilter({ authorId })}
            />
            <div className="field">
              <label htmlFor="report-search">{t("search")}</label>
              <input
                id="report-search"
                type="search"
                maxLength={200}
                value={draft.search}
                disabled={busy}
                placeholder={t("searchPlaceholder")}
                onChange={(event) =>
                  changeFilter({ search: event.target.value })
                }
              />
            </div>
          </div>
          <div className={styles.toolbar}>
            <div className={styles.toolbarActions}>
              <button
                type="submit"
                className="button secondary"
                disabled={busy}
              >
                {t("apply")}
              </button>
              {narrowing && (
                <button
                  type="button"
                  className="button small secondary"
                  disabled={busy}
                  onClick={clearFilters}
                >
                  {t("clear")}
                </button>
              )}
              <button
                type="button"
                className="button small secondary"
                disabled={busy}
                onClick={today}
              >
                {t("today")}
              </button>
            </div>
            <button
              type="button"
              className={`button small ${mine ? "" : "secondary"}`}
              aria-pressed={mine}
              disabled={busy}
              onClick={() =>
                update({
                  mine: mine ? null : "true",
                  authorId: null,
                  page: null,
                })
              }
            >
              {t("myReports")}
            </button>
          </div>
        </form>
      </section>
      <div className={styles.feedHeading}>
        <div>
          <h2>
            {data
              ? t("feedFor", { date: date(data.date, locale) })
              : t("feedTitle")}
          </h2>
          <p className={styles.caption}>
            {mine ? t("myReports") : t("allReports")}
            {data ? ` · ${t("reportCount", { count: data.total })}` : ""}
          </p>
        </div>
        {feed.isFetching && data && (
          <span className={styles.caption} role="status">
            {t("refreshing")}
          </span>
        )}
      </div>
      <section
        className={styles.feed}
        aria-label={t("feedTitle")}
        aria-busy={feed.isFetching}
      >
        {feed.loading ? (
          <Loading />
        ) : (
          data &&
          (data.items.length ? (
            data.items.map((report) => (
              <WorkReportCard
                key={report.id}
                report={report}
                timezone={data.timezone}
                disabled={disabled}
                onEdit={edit}
                onDelete={(report) => void removeReport(report)}
              />
            ))
          ) : (
            <div className="card">
              <Empty
                title={
                  data.total > 0
                    ? t("emptyPage")
                    : narrowing
                      ? t("emptyMatching")
                      : t("emptyDate")
                }
                description={
                  data.total > 0
                    ? t("emptyPageDescription")
                    : narrowing
                      ? t("emptyMatchingDescription")
                      : t("emptyDateDescription")
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
                ) : narrowing ? (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={clearFilters}
                  >
                    {t("clear")}
                  </button>
                ) : (
                  historical && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={today}
                    >
                      {t("today")}
                    </button>
                  )
                )}
              </div>
            </div>
          ))
        )}
      </section>
      {data && (
        <section className="card">
          <div className={styles.pageSize}>
            <label htmlFor="report-page-size">{t("pageSize")}</label>
            <select
              id="report-page-size"
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
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            loading={busy || feed.isFetching}
            onPage={(page) => update({ page })}
          />
        </section>
      )}
      {editor && (
        <WorkReportForm
          key={`${editor.report.id}:${editor.report.version}:${editor.revision}`}
          report={editor.report}
          timezone={data?.timezone ?? "Asia/Dhaka"}
          busy={busy}
          blocked={blocked}
          error={errorContext === "editor" ? actionError : ""}
          onSave={editReport}
          onRefresh={() => void reloadEditor()}
          onClose={() => {
            setEditor(null);
            setActionError("");
            setErrorContext(null);
          }}
        />
      )}
    </div>
  );
}
