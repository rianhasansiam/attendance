"use client";

import { useRef, useState } from "react";
import { useUrlFilters, pageFromSearch } from "@/lib/client/use-url-filters";
import { errorMessage } from "@/store/api/errors";
import { DELETED_INFO } from "@/lib/deleted-info";
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

function timestamp(value: string | null, timeZone: string) {
  return value ? new Date(value).toLocaleString(undefined, { timeZone }) : "—";
}

export function LateApprovalsWorkspace() {
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
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");

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
      setActionError("This request has changed. Refresh before reviewing it.");
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
      setMessage(`Late approval request ${status.toLowerCase()}.`);
    } catch (error) {
      setActionError(errorMessage(error));
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
        eyebrow="ATTENDANCE REVIEW"
        title="Late approvals"
        description="Review requests to excuse late arrivals. Approval preserves actual arrival times and does not increase overtime."
        action={<Refresh onClick={() => void refreshRequests()} />}
      />
      <ErrorNotice message={error || (!reviewing ? actionError : "")} />
      {needsReconcile && (
        <Notice>
          Refresh these requests successfully before another decision.
        </Notice>
      )}
      {message && <Notice notify>{message}</Notice>}
      <section className="card">
        <div className="toolbar">
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="late-approval-status">Request status</label>
            <select
              id="late-approval-status"
              value={filter}
              disabled={busy || needsReconcile}
              onChange={(event) =>
                update({ status: event.target.value, page: null })
              }
            >
              <option value="PENDING">Pending</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
              <option value="all">All requests</option>
            </select>
          </div>
          {isFetching && data && (
            <span className="muted" role="status">
              Refreshing…
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
                    DELETED_INFO,
                  scheduledStart: request.scheduledStartAt
                    ? time(
                        request.scheduledStartAt,
                        request.attendance.shift.timezone,
                      )
                    : "Unknown",
                  arrival: time(
                    request.checkInAt,
                    request.attendance.shift.timezone,
                  ),
                  submitted: timestamp(
                    request.requestedAt,
                    request.attendance.shift.timezone,
                  ),
                }))}
                columns={[
                  { key: "employeeName", label: "Employee" },
                  {
                    key: "attendance.employee.employeeCode",
                    label: "Employee ID",
                  },
                  {
                    key: "attendance.attendanceDate",
                    label: "Date",
                    format: "date",
                  },
                  { key: "scheduledStart", label: "Scheduled start" },
                  { key: "arrival", label: "Actual check-in" },
                  { key: "attendance.shift.timezone", label: "Timezone" },
                  { key: "lateMinutes", label: "Actual late (min)" },
                  { key: "reason", label: "Submitted reason", format: "text" },
                  { key: "status", label: "Status", format: "badge" },
                  { key: "submitted", label: "Submitted at" },
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
                    {row.canReview ? "Review" : "View"}
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
          title="Review late approval"
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
                  DELETED_INFO}
              </strong>{" "}
              · {date(reviewing.attendance.attendanceDate)}
            </p>
            <p className="muted">
              Scheduled start:{" "}
              {reviewing.scheduledStartAt
                ? time(reviewing.scheduledStartAt, timezone)
                : "Unknown (historical record)"}
              <br />
              Actual check-in: {time(reviewing.checkInAt, timezone)} ·{" "}
              {reviewing.lateMinutes} minutes late
              <br />
              Submitted: {timestamp(reviewing.requestedAt, timezone)} ·{" "}
              {timezone}
            </p>
            <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {reviewing.reason}
            </p>
            <Badge value={reviewing.status} />
            {attendanceChanged && (
              <p className="notice">
                Attendance changed after this request. Current check-in:{" "}
                {time(reviewing.attendance.checkInAt, timezone)}; current late
                duration: {reviewing.attendance.lateMinutes} minutes. This
                request cannot be approved.
              </p>
            )}
            {reviewing.status === "PENDING" &&
            !reviewing.attendance.employee ? (
              <p className="notice">
                This employee was deleted. This request is retained as history
                and cannot be reviewed.
              </p>
            ) : reviewing.status === "PENDING" ? (
              <>
                <div className="field">
                  <label htmlFor="late-approval-review-note">
                    Review note (optional)
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
                    Refresh requests
                  </button>
                )}
                <div className="form-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={disabled}
                    onClick={() => void decide("REJECTED")}
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={disabled || attendanceChanged}
                    onClick={() => void decide("APPROVED")}
                  >
                    {busy ? "Saving…" : "Approve"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="muted">
                  Reviewed by{" "}
                  {reviewing.reviewedBy?.name ||
                    reviewing.reviewedBy?.email ||
                    DELETED_INFO}{" "}
                  · {timestamp(reviewing.reviewedAt, timezone)}
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
