"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { confirmAction } from "@/lib/client/alerts";
import { useDebouncedValue } from "@/lib/client/use-debounced-value";
import { pageFromSearch, useUrlFilters } from "@/lib/client/use-url-filters";
import { useFreshness } from "@/store/freshness";
import { useAppDispatch } from "@/store/hooks";
import { useQueryView } from "@/store/use-query-view";
import {
  attendanceApi,
  useOvertimeRequestsQuery,
  useReviewOvertimeRequestMutation,
} from "@/store/features/attendance/api";
import type {
  OvertimeRequest,
  OvertimeRequestStatus,
} from "@/store/features/attendance/contracts";
import { useGetReferenceQuery } from "@/store/features/management/api";
import { useEmployeeError, useEmployeeMessage } from "./employee-feedback";
import { Modal } from "./modal";
import {
  Badge,
  date,
  duration,
  ErrorNotice,
  Loading,
  Notice,
  PageHeader,
  Pagination,
  Refresh,
  Table,
} from "./ui";

function DepartmentFilter({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("employee");
  const common = useTranslations("common");
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search);
  const [paging, setPaging] = useState({ query: "", page: 1 });
  const page = paging.query === query ? paging.page : 1;
  const result = useGetReferenceQuery(
    { resource: "departments", params: { page, pageSize: 100, q: query } },
    useFreshness(),
  );
  const view = useQueryView(result);
  return (
    <div className="field">
      <label htmlFor="overtime-department">
        {t("overtimeRequests.department")}
      </label>
      <select
        id="overtime-department"
        value={value}
        disabled={disabled || view.loading}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{t("overtimeRequests.allDepartments")}</option>
        {value && !view.data?.items.some((item) => item.id === value) && (
          <option value={value}>
            {t("overtimeRequests.currentDepartment")}
          </option>
        )}
        {view.data?.items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      {((view.data?.total ?? 0) > 100 || search || page > 1) && (
        <>
          <input
            type="search"
            aria-label={t("overtimeRequests.searchDepartments")}
            placeholder={t("overtimeRequests.searchDepartments")}
            value={search}
            maxLength={100}
            disabled={disabled}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="buttons">
            <button
              type="button"
              className="button small secondary"
              disabled={disabled || view.isFetching || page <= 1}
              onClick={() => setPaging({ query, page: page - 1 })}
            >
              {common("previous")}
            </button>
            <button
              type="button"
              className="button small secondary"
              disabled={
                disabled ||
                view.isFetching ||
                page * 100 >= (view.data?.total ?? 0)
              }
              onClick={() => setPaging({ query, page: page + 1 })}
            >
              {common("next")}
            </button>
          </div>
        </>
      )}
      <ErrorNotice message={view.error} notify={false} />
    </div>
  );
}

export function OvertimeRequestsWorkspace() {
  const t = useTranslations("employee");
  const locale = useLocale();
  const { params, update } = useUrlFilters();
  const page = pageFromSearch(params.get("page"));
  const filters = {
    status: params.get("status") || "PENDING",
    search: params.get("search") || "",
    from: params.get("from") || "",
    to: params.get("to") || "",
    departmentId: params.get("departmentId") || "",
  };
  const filterKey = JSON.stringify(filters);
  const [edited, setEdited] = useState<{
    key: string;
    value: typeof filters;
  }>();
  const draft = edited?.key === filterKey ? edited.value : filters;
  const changeFilter = (patch: Partial<typeof filters>) =>
    setEdited({ key: filterKey, value: { ...draft, ...patch } });
  const status = (["PENDING", "APPROVED", "REJECTED"] as const).find(
    (value) => value === filters.status,
  );
  const query = {
    page,
    pageSize: 25,
    ...(status ? { status } : {}),
    ...(filters.search ? { search: filters.search } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
    ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
  };
  const result = useOvertimeRequestsQuery(query, useFreshness(true));
  const { data, error, loading, refresh, isFetching } = useQueryView(result);
  const dispatch = useAppDispatch();
  const [reviewRequest] = useReviewOvertimeRequestMutation();
  const [reviewing, setReviewing] = useState<OvertimeRequest | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsReconcile, setNeedsReconcile] = useState(false);
  const [actionError, setActionError] = useEmployeeError();
  const [message, setMessage] = useEmployeeMessage();
  const [invalidRange, setInvalidRange] = useState(false);
  const submitting = useRef(false);
  const active = useRef(true);
  const generation = useRef(0);
  const latestData = useRef(data);
  const write = useRef<{ abort: () => void } | null>(null);
  useEffect(() => {
    latestData.current = data;
  }, [data]);
  useEffect(() => {
    active.current = true;
    const startedGeneration = generation.current;
    return () => {
      active.current = false;
      generation.current = startedGeneration + 1;
      if (write.current) {
        write.current.abort();
        write.current = null;
        setNeedsReconcile(true);
      }
      submitting.current = false;
      setBusy(false);
      setReviewing(null);
    };
  }, []);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || needsReconcile) return;
    if (draft.from && draft.to && draft.to < draft.from) {
      setInvalidRange(true);
      return;
    }
    setInvalidRange(false);
    setReviewing(null);
    update({ ...draft, search: draft.search.trim(), page: null });
  }

  async function refreshRequests() {
    const startedGeneration = generation.current;
    try {
      const running = dispatch(
        attendanceApi.util.getRunningQueryThunk("overtimeRequests", query),
      );
      if (running) {
        running.abort();
        await running;
      }
      const latest = await refresh().unwrap();
      if (!active.current || startedGeneration !== generation.current) return;
      latestData.current = latest;
      setNeedsReconcile(false);
      setReviewing((current) =>
        current
          ? (latest.items.find((item) => item.id === current.id) ?? null)
          : null,
      );
    } catch {
      // Keep decisions disabled until an authoritative reconciliation succeeds.
    }
  }

  async function decide(status: Exclude<OvertimeRequestStatus, "PENDING">) {
    if (!reviewing || submitting.current || needsReconcile || isFetching)
      return;
    const expected = reviewing;
    const startedGeneration = generation.current;
    const currentAttempt = () =>
      active.current && startedGeneration === generation.current;
    submitting.current = true;
    setBusy(true);
    setActionError("");
    setMessage("");
    try {
      const confirmed = await confirmAction({
        title: t(
          status === "APPROVED"
            ? "overtimeRequests.approveTitle"
            : "overtimeRequests.rejectTitle",
        ),
        text: t(
          status === "APPROVED"
            ? "overtimeRequests.approveDescription"
            : "overtimeRequests.rejectDescription",
          {
            duration: duration(expected.requestedMinutes, locale),
          },
        ),
        confirmText: t(
          status === "APPROVED" ? "common.approve" : "common.reject",
        ),
        danger: status === "REJECTED",
      });
      if (!confirmed || !currentAttempt()) return;
      const current = latestData.current?.items.find(
        (item) => item.id === expected.id,
      );
      if (
        current?.status !== "PENDING" ||
        current.updatedAt !== expected.updatedAt ||
        !current.attendance.employee ||
        (status === "APPROVED" && !current.matchesAttendance)
      ) {
        setActionError({ key: "overtimeRequests.changed" });
        setNeedsReconcile(true);
        await refreshRequests();
        return;
      }
      const request = reviewRequest({
        id: current.id,
        status,
        ...(status === "REJECTED" && rejectionReason.trim()
          ? { rejectionReason: rejectionReason.trim() }
          : {}),
      });
      write.current = request;
      await request.unwrap();
      if (!currentAttempt()) return;
      setReviewing(null);
      setMessage(
        status === "APPROVED"
          ? "overtimeRequests.approved"
          : "overtimeRequests.rejected",
      );
    } catch (error) {
      if (!currentAttempt()) return;
      setActionError(error);
      setNeedsReconcile(true);
      await refreshRequests();
    } finally {
      if (startedGeneration === generation.current) {
        write.current = null;
        submitting.current = false;
        if (active.current) setBusy(false);
      }
    }
  }

  const disabled = busy || needsReconcile || isFetching || !!error;
  const timestamp = (value: string | null, timezone: string) =>
    value
      ? new Date(value).toLocaleString(locale, { timeZone: timezone })
      : "—";
  const timezone = reviewing?.attendance.shift.timezone || "UTC";
  return (
    <>
      <PageHeader
        eyebrow={t("overtimeRequests.eyebrow")}
        title={t("overtimeRequests.title")}
        description={t("overtimeRequests.description")}
        action={<Refresh onClick={() => !busy && void refreshRequests()} />}
      />
      <ErrorNotice message={error || (!reviewing ? actionError : "")} />
      {needsReconcile && <Notice>{t("overtimeRequests.reconcile")}</Notice>}
      {message && <Notice notify>{message}</Notice>}
      <section className="card">
        <form className="card-body" onSubmit={applyFilters}>
          <div className="filter-grid">
            <div className="field">
              <label htmlFor="overtime-search">
                {t("overtimeRequests.search")}
              </label>
              <input
                id="overtime-search"
                type="search"
                maxLength={100}
                value={draft.search}
                disabled={busy || needsReconcile}
                onChange={(event) =>
                  changeFilter({ search: event.target.value })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="overtime-status">
                {t("approvals.requestStatus")}
              </label>
              <select
                id="overtime-status"
                value={draft.status}
                disabled={busy || needsReconcile}
                onChange={(event) =>
                  changeFilter({ status: event.target.value })
                }
              >
                <option value="PENDING">{t("common.pending")}</option>
                <option value="APPROVED">{t("common.approved")}</option>
                <option value="REJECTED">{t("common.rejected")}</option>
                <option value="all">{t("approvals.all")}</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="overtime-from">{t("history.from")}</label>
              <input
                id="overtime-from"
                type="date"
                value={draft.from}
                disabled={busy || needsReconcile}
                onChange={(event) => changeFilter({ from: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="overtime-to">{t("history.to")}</label>
              <input
                id="overtime-to"
                type="date"
                min={draft.from || undefined}
                value={draft.to}
                disabled={busy || needsReconcile}
                onChange={(event) => changeFilter({ to: event.target.value })}
              />
            </div>
            <DepartmentFilter
              value={draft.departmentId}
              disabled={busy || needsReconcile}
              onChange={(departmentId) => changeFilter({ departmentId })}
            />
          </div>
          <ErrorNotice
            message={invalidRange ? t("overtimeRequests.invalidRange") : ""}
            notify={false}
          />
          <button
            type="submit"
            className="button secondary"
            disabled={busy || needsReconcile}
          >
            {t("overtimeRequests.apply")}
          </button>
          {isFetching && data && (
            <span className="muted" role="status">
              {" "}
              {t("common.refreshing")}
            </span>
          )}
        </form>
        {loading ? (
          <Loading />
        ) : (
          data && (
            <>
              <Table
                rows={data.items.map((request) => ({
                  ...request,
                  employeeName:
                    request.attendance.employee?.user.name ||
                    request.attendance.employee?.user.email ||
                    t("common.deleted"),
                  scheduledEnd: timestamp(
                    request.scheduledEndAt,
                    request.attendance.shift.timezone,
                  ),
                  checkoutTime: timestamp(
                    request.checkOutAt,
                    request.attendance.shift.timezone,
                  ),
                }))}
                columns={[
                  { key: "employeeName", label: t("columns.employee") },
                  {
                    key: "attendance.employee.employeeCode",
                    label: t("columns.employeeId"),
                  },
                  {
                    key: "attendance.employee.department.name",
                    label: t("overtimeRequests.department"),
                  },
                  {
                    key: "attendance.attendanceDate",
                    label: t("columns.date"),
                    format: "date",
                  },
                  {
                    key: "scheduledEnd",
                    label: t("overtimeReason.scheduledEnd"),
                  },
                  { key: "checkoutTime", label: t("columns.checkOut") },
                  {
                    key: "requestedMinutes",
                    label: t("columns.requestedOvertime"),
                    format: "duration",
                  },
                  {
                    key: "reason",
                    label: t("overtimeReason.reason"),
                    format: "text",
                  },
                  {
                    key: "status",
                    label: t("columns.status"),
                    format: "badge",
                  },
                ]}
                actions={(row) => (
                  <button
                    type="button"
                    className="button small secondary"
                    disabled={disabled}
                    onClick={() => {
                      const request = data.items.find(
                        (item) => item.id === row.id,
                      );
                      if (!request) return;
                      setReviewing(request);
                      setRejectionReason("");
                      setActionError("");
                    }}
                  >
                    {row.status === "PENDING"
                      ? t("common.review")
                      : t("common.view")}
                  </button>
                )}
              />
              <Pagination
                page={page}
                pageSize={data.pageSize}
                total={data.total}
                loading={disabled}
                onPage={(next) => update({ page: next })}
              />
            </>
          )
        )}
      </section>
      {reviewing && (
        <Modal
          title={t("overtimeRequests.reviewTitle")}
          close={() => !busy && setReviewing(null)}
        >
          <ErrorNotice message={actionError} />
          <div className="stack">
            <p>
              <strong>
                {reviewing.attendance.employee?.user.name ||
                  reviewing.attendance.employee?.user.email ||
                  t("common.deleted")}
              </strong>{" "}
              · {date(reviewing.attendance.attendanceDate, locale)}
            </p>
            <Badge value={reviewing.status} />
            <p className="muted">
              {t("overtimeRequests.details", {
                scheduled: timestamp(reviewing.scheduledEndAt, timezone),
                checkout: timestamp(reviewing.checkOutAt, timezone),
                duration: duration(reviewing.requestedMinutes, locale),
              })}
            </p>
            <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {reviewing.reason}
            </p>
            {!reviewing.matchesAttendance && (
              <Notice>{t("overtimeRequests.attendanceChanged")}</Notice>
            )}
            {!reviewing.attendance.employee ? (
              <Notice>{t("approvals.deletedEmployee")}</Notice>
            ) : reviewing.status === "PENDING" ? (
              <>
                <div className="field">
                  <label htmlFor="overtime-rejection-reason">
                    {t("overtimeRequests.rejectionReason")}
                  </label>
                  <textarea
                    id="overtime-rejection-reason"
                    rows={3}
                    maxLength={1000}
                    value={rejectionReason}
                    disabled={disabled}
                    onChange={(event) => setRejectionReason(event.target.value)}
                  />
                </div>
                {needsReconcile && (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void refreshRequests()}
                  >
                    {t("approvals.refresh")}
                  </button>
                )}
                <div className="form-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={disabled}
                    onClick={() => void decide("REJECTED")}
                  >
                    {t("common.reject")}
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={disabled || !reviewing.matchesAttendance}
                    onClick={() => void decide("APPROVED")}
                  >
                    {busy ? t("common.saving") : t("common.approve")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="muted">
                  {t("approvals.reviewedBy", {
                    name:
                      reviewing.reviewedBy?.name ||
                      reviewing.reviewedBy?.email ||
                      t("common.deleted"),
                    time: timestamp(reviewing.reviewedAt, timezone),
                  })}
                </p>
                {reviewing.rejectionReason && (
                  <p
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  >
                    {reviewing.rejectionReason}
                  </p>
                )}
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
