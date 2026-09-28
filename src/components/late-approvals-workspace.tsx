"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEmployeeError, useEmployeeMessage } from "./employee-feedback";

import { useRef, useState } from "react";
import { useUrlFilters, pageFromSearch } from "@/lib/client/use-url-filters";
import { useFreshness } from "@/store/freshness";
import { useAppDispatch } from "@/store/hooks";
import { useQueryView } from "@/store/use-query-view";
import {
  attendanceApi,
  useLateApprovalsQuery,
  useReviewLateApprovalMutation,
} from "@/store/features/attendance/api";
import type {
  LateApprovalRequest,
  LateApprovalStatus,
} from "@/store/features/attendance/contracts";
import { Modal } from "./modal";
import {
  Badge,
  date,
  ErrorNotice,
  Loading,
  Notice,
  PageHeader,
  Pagination,
  Refresh,
  Table,
  time,
} from "./ui";

function timestamp(value: string | null, timeZone: string, locale: string) {
  return value ? new Date(value).toLocaleString(locale, { timeZone }) : "—";
}

export function LateApprovalsWorkspace() {
  const t = useTranslations("employee");
  const locale = useLocale();
  const { params, update } = useUrlFilters();
  const page = pageFromSearch(params.get("page"));
  const filter = params.get("status") || "PENDING";
  const status = (["PENDING", "APPROVED", "REJECTED"] as const).find(
    (value) => value === filter,
  );
  const query = { page, pageSize: 25, ...(status ? { status } : {}) };
  const result = useLateApprovalsQuery(query, useFreshness(true));
  const { data, error, loading, refresh, isFetching } = useQueryView(result);
  const dispatch = useAppDispatch();
  const [reviewLateApproval] = useReviewLateApprovalMutation();
  const [reviewing, setReviewing] = useState<LateApprovalRequest | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [needsReconcile, setNeedsReconcile] = useState(false);
  const [actionError, setActionError] = useEmployeeError();
  const [message, setMessage] = useEmployeeMessage();

  async function refreshRequests() {
    try {
      // A poll that began before an uncertain decision is not a recovery read.
      const running = dispatch(
        attendanceApi.util.getRunningQueryThunk("lateApprovals", query),
      );
      if (running) {
        running.abort();
        await running;
      }
      const latest = await refresh().unwrap();
      setNeedsReconcile(false);
      setReviewing((current) =>
        current
          ? (latest.items.find((item) => item.id === current.id) ?? null)
          : null,
      );
    } catch {
      // Keep decisions disabled until an authoritative read succeeds.
    }
  }

  async function decide(status: Exclude<LateApprovalStatus, "PENDING">) {
    if (!reviewing || submitting.current || needsReconcile || isFetching)
      return;
    const current = data?.items.find((item) => item.id === reviewing.id);
    if (current?.status !== "PENDING") {
      setActionError({ key: "approvals.changed" });
      setNeedsReconcile(true);
      return;
    }
    submitting.current = true;
    setBusy(true);
    setActionError("");
    setMessage("");
    try {
      await reviewLateApproval({
        id: current.id,
        status,
        ...(reviewNote.trim() ? { reviewNote: reviewNote.trim() } : {}),
      }).unwrap();
      setReviewing(null);
      setMessage(
        status === "APPROVED" ? "approvals.approved" : "approvals.rejected",
      );
    } catch (error) {
      setActionError(error);
      setNeedsReconcile(true);
      await refreshRequests();
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const disabled = busy || needsReconcile || isFetching || !!error;
  const timezone = reviewing?.attendance.shift.timezone || "UTC";
  const attendanceChanged =
    !!reviewing &&
    (reviewing.checkInAt !== reviewing.attendance.checkInAt ||
      reviewing.lateMinutes !== reviewing.attendance.lateMinutes);
  return (
    <>
      <PageHeader
        eyebrow={t("approvals.eyebrow")}
        title={t("approvals.title")}
        description={t("approvals.description")}
        action={<Refresh onClick={() => void refreshRequests()} />}
      />
      <ErrorNotice message={error || (!reviewing ? actionError : "")} />
      {needsReconcile && <Notice>{t("approvals.reconcile")}</Notice>}
      {message && <Notice notify>{message}</Notice>}
      <section className="card">
        <div className="toolbar">
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="late-approval-status">
              {t("approvals.requestStatus")}
            </label>
            <select
              id="late-approval-status"
              value={filter}
              disabled={busy || needsReconcile}
              onChange={(event) =>
                update({ status: event.target.value, page: null })
              }
            >
              <option value="PENDING">{t("common.pending")}</option>
              <option value="APPROVED">{t("common.approved")}</option>
              <option value="REJECTED">{t("common.rejected")}</option>
              <option value="all">{t("approvals.all")}</option>
            </select>
          </div>
          {isFetching && data && (
            <span className="muted" role="status">
              {t("common.refreshing")}
            </span>
          )}
        </div>
        {loading ? (
          <Loading />
        ) : (
          data && (
            <>
              <Table
                rows={data.items.map((request) => ({
                  ...request,
                  canReview:
                    request.status === "PENDING" &&
                    !!request.attendance.employee,
                  employeeName:
                    request.attendance.employee?.user.name ||
                    request.attendance.employee?.user.email ||
                    t("common.deleted"),
                  scheduledStart: request.scheduledStartAt
                    ? time(
                        request.scheduledStartAt,
                        request.attendance.shift.timezone,
                        locale,
                      )
                    : t("common.unknown"),
                  arrival: time(
                    request.checkInAt,
                    request.attendance.shift.timezone,
                    locale,
                  ),
                  submitted: timestamp(
                    request.requestedAt,
                    request.attendance.shift.timezone,
                    locale,
                  ),
                }))}
                columns={[
                  { key: "employeeName", label: t("columns.employee") },
                  {
                    key: "attendance.employee.employeeCode",
                    label: t("columns.employeeId"),
                  },
                  {
                    key: "attendance.attendanceDate",
                    label: t("columns.date"),
                    format: "date",
                  },
                  { key: "scheduledStart", label: t("columns.scheduledStart") },
                  { key: "arrival", label: t("columns.actualCheckIn") },
                  {
                    key: "attendance.shift.timezone",
                    label: t("columns.timezone"),
                  },
                  { key: "lateMinutes", label: t("columns.lateMinutes") },
                  {
                    key: "reason",
                    label: t("columns.submittedReason"),
                    format: "text",
                  },
                  {
                    key: "status",
                    label: t("columns.status"),
                    format: "badge",
                  },
                  { key: "submitted", label: t("columns.submittedAt") },
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
                      setReviewNote("");
                      setActionError("");
                    }}
                  >
                    {row.canReview ? t("common.review") : t("common.view")}
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
          title={t("approvals.reviewTitle")}
          close={() => {
            if (!busy) setReviewing(null);
          }}
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
            <p className="muted">
              {t("approvals.scheduledStart", {
                time: reviewing.scheduledStartAt
                  ? time(reviewing.scheduledStartAt, timezone, locale)
                  : t("approvals.unknownHistorical"),
              })}
              <br />
              {t("approvals.actualArrival", {
                time: time(reviewing.checkInAt, timezone, locale),
                count: reviewing.lateMinutes,
              })}
              <br />
              {t("approvals.submittedDetails", {
                time: timestamp(reviewing.requestedAt, timezone, locale),
                timezone,
              })}
            </p>
            <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {reviewing.reason}
            </p>
            <Badge value={reviewing.status} />
            {attendanceChanged && (
              <p className="notice">
                {t("approvals.attendanceChanged", {
                  time: time(reviewing.attendance.checkInAt, timezone, locale),
                  count: reviewing.attendance.lateMinutes,
                })}
              </p>
            )}
            {reviewing.status === "PENDING" &&
            !reviewing.attendance.employee ? (
              <p className="notice">{t("approvals.deletedEmployee")}</p>
            ) : reviewing.status === "PENDING" ? (
              <>
                <div className="field">
                  <label htmlFor="late-approval-review-note">
                    {t("approvals.reviewNote")}
                  </label>
                  <textarea
                    id="late-approval-review-note"
                    rows={3}
                    maxLength={1000}
                    value={reviewNote}
                    disabled={disabled}
                    onChange={(event) => setReviewNote(event.target.value)}
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
                    disabled={disabled || attendanceChanged}
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
                    time: timestamp(reviewing.reviewedAt, timezone, locale),
                  })}
                </p>
                {reviewing.reviewNote && (
                  <p
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  >
                    {reviewing.reviewNote}
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
