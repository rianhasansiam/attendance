"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  CalendarCheck2,
  Check,
  Clock3,
  Download,
  Fingerprint,
  Pencil,
  Settings2,
  ShieldCheck,
  Users,
} from "lucide-react";
import {
  duration,
  ErrorNotice,
  items,
  Loading,
  Metric,
  Notice,
  PageHeader,
  Refresh,
  Table,
  type DataRow,
} from "./ui";
import { useUrlFilters, pageFromSearch } from "@/lib/client/use-url-filters";
import { errorMessage } from "@/store/api/errors";
import { isAmbiguousWrite } from "@/lib/client/attendance-ceremony";
import { useFreshness } from "@/store/freshness";
import { useQueryView } from "@/store/use-query-view";
import {
  useGetManagementQuery,
  useWriteManagementMutation,
} from "@/store/features/management/api";
import type { JsonRecord } from "@/store/features/management/contracts";
import {
  useCorrectAttendanceMutation,
  useGetAdminDashboardQuery,
  useGetAdminReportQuery,
} from "@/store/features/reports/api";
import type {
  AttendanceStatus,
  CorrectionInput,
  ReportFilters,
} from "@/store/features/reports/contracts";
import { FormField, Modal } from "./resource-workspace";
import { PdfDownloadButton } from "./pdf-download-button";

export function AdminDashboard() {
  const result = useGetAdminDashboardQuery(undefined, useFreshness(true));
  const { data, error, loading, refresh, isFetching } = useQueryView(result);
  return (
    <>
      <PageHeader
        eyebrow="YOUR WORKPLACE, AT A GLANCE"
        title="A good day starts here."
        description="A little clarity on your people and their workday."
        action={
          <div className="buttons">
            <Refresh onClick={refresh} />
            <Link className="button" href="/admin/reports">
              <Download size={15} />
              View reports
            </Link>
          </div>
        }
      />
      <ErrorNotice message={error} />
      {loading ? (
        <Loading />
      ) : data ? (
        <>
          <div className="stats-grid">
            <Metric
              featured
              title="Total employees"
              value={data.totalEmployees}
              note="Active people in your workspace"
              icon={<Users size={18} />}
            />
            <Metric
              title="Present today"
              value={data.presentToday}
              note="People with recorded attendance"
              icon={<CalendarCheck2 size={18} />}
            />
            <Metric
              title="Late arrivals"
              value={data.lateToday}
              note="Unexcused arrivals beyond shift grace time"
              icon={<Clock3 size={18} />}
            />
            <Metric
              title="Absent today"
              value={data.absentToday}
              note="Scheduled, with no attendance recorded"
              icon={<Users size={18} />}
            />
          </div>
          <div className="content-grid">
            <section className="card">
              <div className="card-header">
                <div>
                  <h2>Today’s attendance</h2>
                  <p>Refreshes periodically while this view is active.</p>
                </div>
                <span
                  className={`badge ${error ? "amber" : "green"}`}
                  role="status"
                >
                  {isFetching
                    ? "Refreshing…"
                    : error
                      ? "Refresh needed"
                      : "Latest loaded overview"}
                </span>
              </div>
              <div className="card-body">
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 20,
                  }}
                >
                  <div>
                    <span className="muted" style={{ fontSize: 12 }}>
                      Currently checked in
                    </span>
                    <div className="stat-value">{data.currentlyCheckedIn}</div>
                    <p className="stat-note">Workdays in progress</p>
                  </div>
                  <div>
                    <span className="muted" style={{ fontSize: 12 }}>
                      Checked out
                    </span>
                    <div className="stat-value">{data.checkedOut}</div>
                    <p className="stat-note">Workdays completed</p>
                  </div>
                </div>
                <div className="progress-row">
                  <span>Attendance recorded</span>
                  <strong>
                    {data.totalEmployees
                      ? Math.round(
                          (data.presentToday / data.totalEmployees) * 100,
                        )
                      : 0}
                    %
                  </strong>
                </div>
                <div className="progress-track">
                  <span
                    style={{
                      width: `${data.totalEmployees ? Math.min(100, (data.presentToday / data.totalEmployees) * 100) : 0}%`,
                    }}
                  />
                </div>
                <p className="muted" style={{ fontSize: 10, marginTop: 15 }}>
                  Each employee’s day follows their office timezone and assigned
                  schedule.
                </p>
              </div>
            </section>
            <section className="card">
              <div className="card-header">
                <h2>A few useful shortcuts</h2>
                <ArrowUpRight size={17} color="#88987f" />
              </div>
              <div className="card-body">
                <div className="quick-links">
                  <Link className="quick-link" href="/admin/employees">
                    <Users size={17} />
                    Employees
                    <ArrowUpRight size={12} />
                  </Link>
                  <Link className="quick-link" href="/admin/devices">
                    <Fingerprint size={17} />
                    Devices
                    <ArrowUpRight size={12} />
                  </Link>
                  <Link className="quick-link" href="/admin/leaves">
                    <CalendarCheck2 size={17} />
                    Leave requests
                    <ArrowUpRight size={12} />
                  </Link>
                  <Link className="quick-link" href="/admin/late-approvals">
                    <Clock3 size={17} />
                    Late approvals
                    <ArrowUpRight size={12} />
                  </Link>
                  <Link className="quick-link" href="/admin/shifts">
                    <Clock3 size={17} />
                    Shifts
                    <ArrowUpRight size={12} />
                  </Link>
                </div>
              </div>
            </section>
          </div>
          <section className="card">
            <div className="card-header">
              <div>
                <h2>Recent check-ins</h2>
                <p>The latest attendance activity across your offices.</p>
              </div>
              <Link href="/admin/attendance" className="button-link">
                View all
                <ArrowUpRight size={15} />
              </Link>
            </div>
            <Table
              rows={data.recentAttendance}
              columns={[
                { key: "employee.user.name", label: "Employee" },
                { key: "office.name", label: "Office" },
                { key: "checkInAt", label: "Check in", format: "time" },
                { key: "checkOutAt", label: "Check out", format: "time" },
                {
                  key: "overtimeMinutes",
                  label: "Overtime",
                  format: "nullable-duration",
                },
                { key: "status", label: "Status", format: "attendance-status" },
                { key: "lateReason", label: "Late reason", format: "text" },
              ]}
            />
          </section>
        </>
      ) : (
        <Refresh onClick={refresh} />
      )}
    </>
  );
}
const reportColumns = [
  { key: "employee.user.name", label: "Employee" },
  { key: "attendanceDate", label: "Date", format: "date" as const },
  { key: "office.name", label: "Office" },
  { key: "shift.name", label: "Shift" },
  { key: "checkInAt", label: "Check in", format: "time" as const },
  { key: "checkOutAt", label: "Check out", format: "time" as const },
  { key: "workedMinutes", label: "Worked", format: "duration" as const },
  {
    key: "overtimeMinutes",
    label: "Overtime",
    format: "nullable-duration" as const,
  },
  { key: "lateMinutes", label: "Actual late (min)" },
  { key: "status", label: "Status", format: "attendance-status" as const },
  { key: "lateReason", label: "Late reason", format: "text" as const },
];
export function AdminReports({
  attendance = false,
  canCorrectAttendance = false,
}: {
  attendance?: boolean;
  employeeId?: string;
  canCorrectAttendance?: boolean;
}) {
  const { params, update } = useUrlFilters();
  const filterKeys = [
    "employeeId",
    "departmentId",
    "officeId",
    "shiftId",
    "status",
    "from",
    "to",
  ] as const;
  const filters = Object.fromEntries(
    filterKeys.flatMap((key) => {
      const value = params.get(key);
      return value ? [[key, value]] : [];
    }),
  ) as ReportFilters;
  const page = pageFromSearch(params.get("page"));
  const [resetVersion, setResetVersion] = useState(0);
  const [editing, setEditing] = useState<DataRow | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [needsReconcile, setNeedsReconcile] = useState(false);
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const result = useGetAdminReportQuery(
    { ...filters, page, pageSize: 25 },
    useFreshness(attendance),
  );
  const { data, error, loading, refresh, isFetching } = useQueryView(result);
  const [correctAttendance] = useCorrectAttendanceMutation();
  async function refreshReport() {
    try {
      await refresh().unwrap();
      setNeedsReconcile(false);
    } catch {
      // Preserve the uncertainty gate until an authoritative read succeeds.
    }
  }
  function setPage(next: number) {
    update({ page: next });
  }
  function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    update({
      ...Object.fromEntries(
        filterKeys.map((key) => [key, String(form.get(key) || "") || null]),
      ),
      page: null,
    });
  }
  async function correct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !canCorrectAttendance ||
      submitting.current ||
      needsReconcile ||
      isFetching
    )
      return;
    submitting.current = true;
    setBusy(true);
    setActionError("");
    const form = new FormData(event.currentTarget);
    try {
      const toIso = (key: string) => {
        const value = String(form.get(key) || "");
        return value ? new Date(value).toISOString() : null;
      };
      const payload: CorrectionInput = {
        reason: String(form.get("reason") || ""),
        status: String(form.get("status")) as AttendanceStatus,
        checkInAt: toIso("checkInAt"),
        checkOutAt: toIso("checkOutAt"),
      };
      if (!editing || !editing.employee) return;
      await correctAttendance(
        editing.derived
          ? {
              body: {
                ...payload,
                employeeId: String((editing.employee as DataRow).id),
                attendanceDate: String(editing.attendanceDate).slice(0, 10),
              },
            }
          : { id: String(editing.id), body: payload },
      ).unwrap();
      setEditing(null);
      setMessage(
        "Attendance updated. The correction has been added to the audit log.",
      );
    } catch (error) {
      setActionError(errorMessage(error));
      if (isAmbiguousWrite(error)) {
        setNeedsReconcile(true);
        await refreshReport();
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  function localDate(value: unknown) {
    if (!value) return "";
    const date = new Date(String(value));
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  }
  return (
    <>
      <PageHeader
        eyebrow={attendance ? "DAILY RECORDS" : "INSIGHTS & EXPORTS"}
        title={attendance ? "Attendance" : "Attendance reports"}
        description={
          attendance
            ? "Every workday, accounted for."
            : "Turn everyday records into a clearer picture."
        }
        action={
          <div className="buttons">
            <Refresh onClick={() => void refreshReport()} />
            <PdfDownloadButton
              href={`/api/admin/reports?${new URLSearchParams({ ...filters, format: "pdf" })}`}
              filename="attendance-report.pdf"
              disabled={loading}
            />
          </div>
        }
      />
      <ErrorNotice message={error || (!editing ? actionError : "")} />
      {needsReconcile && !editing && (
        <Notice>
          Refresh attendance successfully before another correction.
        </Notice>
      )}
      {message && <Notice notify>{message}</Notice>}
      <section className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <div>
            <h2>Find the right perspective</h2>
            <p>Filter up to 93 days. The last 30 days are shown by default.</p>
          </div>
        </div>
        <form
          key={`${JSON.stringify(filters)}:${resetVersion}`}
          className="card-body"
          onSubmit={filter}
          onReset={(event) => {
            event.preventDefault();
            setResetVersion((value) => value + 1);
            update({
              ...Object.fromEntries(filterKeys.map((key) => [key, null])),
              page: null,
            });
          }}
        >
          <div className="filter-grid">
            <FormField
              row={filters}
              field={{
                name: "employeeId",
                label: "Employee",
                resource: "employees",
              }}
            />
            <FormField
              row={filters}
              field={{
                name: "departmentId",
                label: "Department",
                resource: "departments",
              }}
            />
            <FormField
              row={filters}
              field={{ name: "officeId", label: "Office", resource: "offices" }}
            />
            <FormField
              row={filters}
              field={{ name: "shiftId", label: "Shift", resource: "shifts" }}
            />
            <FormField
              row={filters}
              field={{ name: "from", label: "From date", type: "date" }}
            />
            <FormField
              row={filters}
              field={{ name: "to", label: "To date", type: "date" }}
            />
            <div className="field">
              <label htmlFor="status-filter">Status</label>
              <select
                id="status-filter"
                name="status"
                defaultValue={filters.status || ""}
              >
                <option value="">All statuses</option>
                {[
                  "PRESENT",
                  "LATE",
                  "ABSENT",
                  "HALF_DAY",
                  "LEAVE",
                  "HOLIDAY",
                  "WEEKEND",
                ].map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
              <button className="button" type="submit">
                Apply filters
              </button>
              <button type="reset" className="button secondary">
                Reset
              </button>
            </div>
          </div>
        </form>
      </section>
      {data && (
        <section aria-label="Overtime summary" style={{ marginBottom: 24 }}>
          <Metric
            title="Total overtime"
            value={duration(data.summary.overtimeMinutes)}
            note={`Across all ${data.total} matching records in the selected date range.${
              data.summary.unknownOvertimeRecords > 0
                ? ` Excludes ${data.summary.unknownOvertimeRecords} ${data.summary.unknownOvertimeRecords === 1 ? "record" : "records"} with unknown overtime.`
                : ""
            }`}
            icon={<Clock3 size={18} />}
          />
        </section>
      )}
      <section className="card">
        <div className="card-header">
          <h2>{attendance ? "Attendance records" : "Report results"}</h2>
          <span className="muted" role="status" style={{ fontSize: 12 }}>
            {isFetching && data ? "Refreshing…" : `${data?.total || 0} records`}
          </span>
        </div>
        {loading ? (
          <Loading />
        ) : (
          <Table
            rows={items(data)}
            columns={reportColumns}
            dateGroupKey={attendance ? "attendanceDate" : undefined}
            actions={
              attendance && canCorrectAttendance
                ? (row) =>
                    row.employee ? (
                      <button
                        aria-label="Correct attendance"
                        disabled={busy || needsReconcile || isFetching}
                        className="icon-button"
                        onClick={() => {
                          setEditing(row);
                          setActionError("");
                        }}
                      >
                        <Pencil size={15} />
                      </button>
                    ) : null
                : undefined
            }
          />
        )}
        <div className="pagination">
          <span>Page {page} · Times shown in your browser timezone</span>
          <div className="buttons">
            <button
              className="button small secondary"
              disabled={page <= 1 || loading}
              onClick={() => setPage(page - 1)}
            >
              <ArrowLeft size={13} />
              Previous
            </button>
            <button
              className="button small secondary"
              disabled={page * 25 >= (data?.total || 0) || loading}
              onClick={() => setPage(page + 1)}
            >
              Next
              <ArrowRight size={13} />
            </button>
          </div>
        </div>
      </section>
      {canCorrectAttendance && editing && (
        <Modal
          title="Correct attendance"
          close={() => {
            if (!busy) setEditing(null);
          }}
        >
          <form onSubmit={correct}>
            <ErrorNotice message={actionError} />
            {needsReconcile && (
              <>
                <Notice>
                  The result is uncertain. Refresh attendance before another
                  correction.
                </Notice>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void refreshReport()}
                >
                  Refresh attendance
                </button>
              </>
            )}
            <p className="muted" style={{ fontSize: 12, marginBottom: 22 }}>
              Corrections are recorded in the audit log. Enter times in your
              browser’s local timezone.
            </p>
            <div className="form-grid">
              <FormField
                row={{ checkInAt: localDate(editing.checkInAt) }}
                field={{
                  name: "checkInAt",
                  label: "Check in",
                  type: "datetime-local",
                }}
              />
              <FormField
                row={{ checkOutAt: localDate(editing.checkOutAt) }}
                field={{
                  name: "checkOutAt",
                  label: "Check out",
                  type: "datetime-local",
                }}
              />
              <FormField
                row={{
                  ...editing,
                  status: editing.actualStatus ?? editing.status,
                }}
                field={{
                  name: "status",
                  label: "Attendance status",
                  type: "select",
                  options: [
                    "PRESENT",
                    "LATE",
                    "ABSENT",
                    "HALF_DAY",
                    "LEAVE",
                    "HOLIDAY",
                    "WEEKEND",
                  ],
                }}
              />
              <div className="field full">
                <label htmlFor="correction-reason">Reason for correction</label>
                <textarea
                  required
                  minLength={10}
                  maxLength={1000}
                  name="reason"
                  id="correction-reason"
                />
              </div>
            </div>
            <div className="form-actions">
              <button
                disabled={busy}
                type="button"
                className="button secondary"
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <button
                disabled={busy || needsReconcile || isFetching}
                type="submit"
                className="button"
              >
                {busy ? "Saving…" : "Save correction"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
export function AdminSettings() {
  const result = useGetManagementQuery(
    { resource: "settings", params: { page: 1, pageSize: 100 } },
    useFreshness(),
  );
  const { data, error, loading, refresh, isFetching } = useQueryView(result);
  const [writeManagement] = useWriteManagementMutation();
  const [busy, setBusy] = useState("");
  const submitting = useRef(false);
  const [needsReconcile, setNeedsReconcile] = useState(false);
  async function refreshSettings() {
    try {
      await refresh().unwrap();
      setNeedsReconcile(false);
    } catch {
      // Keep saves disabled while the previous write outcome is unknown.
    }
  }
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const settings = items(data);
  const organization = (settings.find((row) => row.key === "organization")
    ?.value || {}) as DataRow;
  const policy = (settings.find((row) => row.key === "attendance.defaultPolicy")
    ?.value || {}) as DataRow;
  async function save(event: FormEvent<HTMLFormElement>, key: string) {
    event.preventDefault();
    if (submitting.current || needsReconcile || isFetching) return;
    submitting.current = true;
    setBusy(key);
    setActionError("");
    setMessage("");
    const form = new FormData(event.currentTarget);
    const value: JsonRecord =
      key === "organization"
        ? {
            name: String(form.get("name") || ""),
            timezone: String(form.get("timezone") || ""),
          }
        : {
            requireWebAuthn: form.has("requireWebAuthn"),
            requireGeofence: form.has("requireGeofence"),
            requireOfficeNetwork: form.has("requireOfficeNetwork"),
            requireApprovedDevice: form.has("requireApprovedDevice"),
            maximumGpsAccuracyMeters: Number(
              form.get("maximumGpsAccuracyMeters"),
            ),
          };
    try {
      await writeManagement({
        resource: "settings",
        method: "POST",
        body: { key, value },
      }).unwrap();
      setMessage("Workspace settings saved.");
    } catch (error) {
      setActionError(errorMessage(error));
      if (isAmbiguousWrite(error)) {
        setNeedsReconcile(true);
        await refreshSettings();
      }
    } finally {
      submitting.current = false;
      setBusy("");
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="SUPER ADMIN"
        title="Workspace settings"
        description="A secure foundation for your organization."
        action={<Refresh onClick={() => void refreshSettings()} />}
      />
      {isFetching && data && (
        <p className="muted" role="status">
          Refreshing…
        </p>
      )}
      <ErrorNotice message={error || actionError} />
      {needsReconcile && (
        <Notice>Refresh settings successfully before another change.</Notice>
      )}
      {message && (
        <Notice notify>
          <Check size={16} />
          {message}
        </Notice>
      )}
      {loading ? (
        <Loading />
      ) : data ? (
        <div className="stack">
          <section className="card">
            <div className="card-header">
              <div>
                <h2>Organization</h2>
                <p>The basics of your workspace.</p>
              </div>
              <Settings2 size={19} color="#8c9b85" />
            </div>
            <form
              className="card-body"
              onSubmit={(event) => save(event, "organization")}
            >
              <div className="form-grid">
                <FormField
                  row={organization}
                  field={{
                    name: "name",
                    label: "Organization name",
                    required: true,
                  }}
                />
                <FormField
                  row={organization}
                  field={{
                    name: "timezone",
                    label: "Default timezone",
                    default: "UTC",
                    required: true,
                    hint: "Use an IANA timezone such as Asia/Dhaka.",
                  }}
                />
              </div>
              <div className="form-actions">
                <button
                  className="button"
                  disabled={!!busy || needsReconcile || isFetching}
                  type="submit"
                >
                  {busy === "organization" ? "Saving…" : "Save organization"}
                </button>
              </div>
            </form>
          </section>
          <section className="card">
            <div className="card-header">
              <div>
                <h2>Default attendance policy</h2>
                <p>
                  Applies to newly created offices. Manage existing policies
                  from Offices.
                </p>
              </div>
              <ShieldCheck size={19} color="#8c9b85" />
            </div>
            <form
              className="card-body"
              onSubmit={(event) => save(event, "attendance.defaultPolicy")}
            >
              <div className="form-grid">
                {[
                  {
                    name: "requireWebAuthn",
                    label: "Require passkey verification",
                  },
                  { name: "requireGeofence", label: "Require office location" },
                  {
                    name: "requireOfficeNetwork",
                    label: "Require office network",
                  },
                  {
                    name: "requireApprovedDevice",
                    label: "Require approved device",
                  },
                ].map((field) => (
                  <FormField
                    key={field.name}
                    row={policy}
                    field={{ ...field, type: "checkbox", default: true }}
                  />
                ))}
                <FormField
                  row={policy}
                  field={{
                    name: "maximumGpsAccuracyMeters",
                    label: "Maximum GPS uncertainty (meters)",
                    type: "number",
                    min: 1,
                    max: 1000,
                    default: 50,
                    required: true,
                  }}
                />
              </div>
              <div className="form-actions">
                <button
                  className="button"
                  disabled={!!busy || needsReconcile || isFetching}
                  type="submit"
                >
                  {busy === "attendance.defaultPolicy"
                    ? "Saving…"
                    : "Save attendance policy"}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : (
        <Refresh onClick={() => void refreshSettings()} />
      )}
    </>
  );
}
