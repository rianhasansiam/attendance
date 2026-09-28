"use client";

import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
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
import { useErrorMessage } from "@/i18n/errors";
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
import { adminOptionLabel, type AdminTranslator } from "./resource-config";
import { FormField, Modal } from "./resource-workspace";
import { PdfDownloadButton } from "./pdf-download-button";

export function AdminDashboard() {
  const t = useTranslations("admin");
  const locale = useLocale();
  const result = useGetAdminDashboardQuery(undefined, useFreshness(true));
  const { data, error, loading, refresh, isFetching } = useQueryView(result);
  return (
    <>
      <PageHeader
        eyebrow={t("dashboard.eyebrow")}
        title={t("dashboard.title")}
        description={t("dashboard.description")}
        action={
          <div className="buttons">
            <Refresh onClick={refresh} />
            <Link className="button" href="/admin/reports">
              <Download size={15} />
              {t("dashboard.viewReports")}
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
              title={t("dashboard.totalEmployees")}
              value={new Intl.NumberFormat(locale).format(data.totalEmployees)}
              note={t("dashboard.activePeople")}
              icon={<Users size={18} />}
            />
            <Metric
              title={t("dashboard.presentToday")}
              value={new Intl.NumberFormat(locale).format(data.presentToday)}
              note={t("dashboard.recordedPeople")}
              icon={<CalendarCheck2 size={18} />}
            />
            <Metric
              title={t("dashboard.lateArrivals")}
              value={new Intl.NumberFormat(locale).format(data.lateToday)}
              note={t("dashboard.lateNote")}
              icon={<Clock3 size={18} />}
            />
            <Metric
              title={t("dashboard.absentToday")}
              value={new Intl.NumberFormat(locale).format(data.absentToday)}
              note={t("dashboard.absentNote")}
              icon={<Users size={18} />}
            />
          </div>
          <div className="content-grid">
            <section className="card">
              <div className="card-header">
                <div>
                  <h2>{t("dashboard.todayAttendance")}</h2>
                  <p>{t("dashboard.refreshNote")}</p>
                </div>
                <span
                  className={`badge ${error ? "amber" : "green"}`}
                  role="status"
                >
                  {isFetching
                    ? t("common.refreshing")
                    : error
                      ? t("dashboard.refreshNeeded")
                      : t("dashboard.latestOverview")}
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
                      {t("dashboard.currentlyCheckedIn")}
                    </span>
                    <div className="stat-value">
                      {new Intl.NumberFormat(locale).format(
                        data.currentlyCheckedIn,
                      )}
                    </div>
                    <p className="stat-note">{t("dashboard.inProgress")}</p>
                  </div>
                  <div>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {t("dashboard.checkedOut")}
                    </span>
                    <div className="stat-value">
                      {new Intl.NumberFormat(locale).format(data.checkedOut)}
                    </div>
                    <p className="stat-note">{t("dashboard.completed")}</p>
                  </div>
                </div>
                <div className="progress-row">
                  <span>{t("dashboard.attendanceRecorded")}</span>
                  <strong>
                    {new Intl.NumberFormat(locale, {
                      style: "percent",
                      maximumFractionDigits: 0,
                    }).format(
                      data.totalEmployees
                        ? data.presentToday / data.totalEmployees
                        : 0,
                    )}
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
                  {t("dashboard.timezoneNote")}
                </p>
              </div>
            </section>
            <section className="card">
              <div className="card-header">
                <h2>{t("dashboard.shortcuts")}</h2>
                <ArrowUpRight size={17} color="#88987f" />
              </div>
              <div className="card-body">
                <div className="quick-links">
                  <Link className="quick-link" href="/admin/employees">
                    <Users size={17} />
                    {t("labels.employees")}
                    <ArrowUpRight size={12} />
                  </Link>
                  <Link className="quick-link" href="/admin/devices">
                    <Fingerprint size={17} />
                    {t("labels.devices")}
                    <ArrowUpRight size={12} />
                  </Link>
                  <Link className="quick-link" href="/admin/leaves">
                    <CalendarCheck2 size={17} />
                    {t("labels.leaveRequests")}
                    <ArrowUpRight size={12} />
                  </Link>
                  <Link className="quick-link" href="/admin/late-approvals">
                    <Clock3 size={17} />
                    {t("labels.lateApprovals")}
                    <ArrowUpRight size={12} />
                  </Link>
                  <Link className="quick-link" href="/admin/shifts">
                    <Clock3 size={17} />
                    {t("labels.shifts")}
                    <ArrowUpRight size={12} />
                  </Link>
                </div>
              </div>
            </section>
          </div>
          <section className="card">
            <div className="card-header">
              <div>
                <h2>{t("dashboard.recentCheckIns")}</h2>
                <p>{t("dashboard.recentNote")}</p>
              </div>
              <Link href="/admin/attendance" className="button-link">
                {t("common.viewAll")}
                <ArrowUpRight size={15} />
              </Link>
            </div>
            <Table
              rows={data.recentAttendance}
              columns={[
                { key: "employee.user.name", label: t("labels.employee") },
                { key: "office.name", label: t("labels.office") },
                {
                  key: "checkInAt",
                  label: t("labels.checkIn"),
                  format: "time",
                },
                {
                  key: "checkOutAt",
                  label: t("labels.checkOut"),
                  format: "time",
                },
                {
                  key: "overtimeMinutes",
                  label: t("labels.overtime"),
                  format: "nullable-duration",
                },
                {
                  key: "status",
                  label: t("labels.status"),
                  format: "attendance-status",
                },
                {
                  key: "lateReason",
                  label: t("labels.lateReason"),
                  format: "text",
                },
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
const getReportColumns = (t: AdminTranslator) => [
  { key: "employee.user.name", label: t("labels.employee") },
  { key: "attendanceDate", label: t("labels.date"), format: "date" as const },
  { key: "office.name", label: t("labels.office") },
  { key: "shift.name", label: t("labels.shift") },
  { key: "checkInAt", label: t("labels.checkIn"), format: "time" as const },
  { key: "checkOutAt", label: t("labels.checkOut"), format: "time" as const },
  {
    key: "workedMinutes",
    label: t("labels.worked"),
    format: "duration" as const,
  },
  {
    key: "overtimeMinutes",
    label: t("labels.overtime"),
    format: "nullable-duration" as const,
  },
  { key: "lateMinutes", label: t("labels.actualLate") },
  {
    key: "status",
    label: t("labels.status"),
    format: "attendance-status" as const,
  },
  { key: "lateReason", label: t("labels.lateReason"), format: "text" as const },
];
export function AdminReports({
  attendance = false,
  canCorrectAttendance = false,
}: {
  attendance?: boolean;
  employeeId?: string;
  canCorrectAttendance?: boolean;
}) {
  const t = useTranslations("admin");
  const locale = useLocale();
  const reportColumns = getReportColumns(t);
  const errorMessage = useErrorMessage();
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
  const [message, setMessage] = useState<
    "" | "reports.corrected" | "settings.saved"
  >("");
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
      setMessage("reports.corrected");
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
        eyebrow={
          attendance ? t("reports.dailyRecords") : t("reports.insightsExports")
        }
        title={attendance ? t("reports.attendance") : t("reports.title")}
        description={
          attendance
            ? t("reports.attendanceDescription")
            : t("reports.description")
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
        <Notice>{t("reports.refreshBeforeCorrection")}</Notice>
      )}
      {message && <Notice notify>{t(message)}</Notice>}
      <section className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <div>
            <h2>{t("reports.filtersTitle")}</h2>
            <p>{t("reports.filtersDescription")}</p>
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
                label: t("labels.employee"),
                resource: "employees",
              }}
            />
            <FormField
              row={filters}
              field={{
                name: "departmentId",
                label: t("labels.department"),
                resource: "departments",
              }}
            />
            <FormField
              row={filters}
              field={{
                name: "officeId",
                label: t("labels.office"),
                resource: "offices",
              }}
            />
            <FormField
              row={filters}
              field={{
                name: "shiftId",
                label: t("labels.shift"),
                resource: "shifts",
              }}
            />
            <FormField
              row={filters}
              field={{
                name: "from",
                label: t("labels.fromDate"),
                type: "date",
              }}
            />
            <FormField
              row={filters}
              field={{ name: "to", label: t("labels.toDate"), type: "date" }}
            />
            <div className="field">
              <label htmlFor="status-filter">{t("labels.status")}</label>
              <select
                id="status-filter"
                name="status"
                defaultValue={filters.status || ""}
              >
                <option value="">{t("reports.allStatuses")}</option>
                {[
                  "PRESENT",
                  "LATE",
                  "ABSENT",
                  "HALF_DAY",
                  "LEAVE",
                  "HOLIDAY",
                  "WEEKEND",
                ].map((status) => (
                  <option key={status} value={status}>
                    {adminOptionLabel(t, status)}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
              <button className="button" type="submit">
                {t("reports.applyFilters")}
              </button>
              <button type="reset" className="button secondary">
                {t("common.reset")}
              </button>
            </div>
          </div>
        </form>
      </section>
      {data && (
        <section
          aria-label={t("reports.overtimeSummary")}
          style={{ marginBottom: 24 }}
        >
          <Metric
            title={t("reports.totalOvertime")}
            value={duration(data.summary.overtimeMinutes, locale)}
            note={t("reports.overtimeNote", {
              count: data.total,
              unknown: data.summary.unknownOvertimeRecords,
            })}
            icon={<Clock3 size={18} />}
          />
        </section>
      )}
      <section className="card">
        <div className="card-header">
          <h2>
            {attendance ? t("reports.attendanceRecords") : t("reports.results")}
          </h2>
          <span className="muted" role="status" style={{ fontSize: 12 }}>
            {isFetching && data
              ? t("common.refreshing")
              : t("common.records", { count: data?.total || 0 })}
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
                        aria-label={t("reports.correctAttendance")}
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
          <span>{t("reports.page", { page })}</span>
          <div className="buttons">
            <button
              className="button small secondary"
              disabled={page <= 1 || loading}
              onClick={() => setPage(page - 1)}
            >
              <ArrowLeft size={13} />
              {t("common.previous")}
            </button>
            <button
              className="button small secondary"
              disabled={page * 25 >= (data?.total || 0) || loading}
              onClick={() => setPage(page + 1)}
            >
              {t("common.next")}
              <ArrowRight size={13} />
            </button>
          </div>
        </div>
      </section>
      {canCorrectAttendance && editing && (
        <Modal
          title={t("reports.correctAttendance")}
          close={() => {
            if (!busy) setEditing(null);
          }}
        >
          <form onSubmit={correct}>
            <ErrorNotice message={actionError} />
            {needsReconcile && (
              <>
                <Notice>{t("reports.uncertainCorrection")}</Notice>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void refreshReport()}
                >
                  {t("reports.refreshAttendance")}
                </button>
              </>
            )}
            <p className="muted" style={{ fontSize: 12, marginBottom: 22 }}>
              {t("reports.correctionHint")}
            </p>
            <div className="form-grid">
              <FormField
                row={{ checkInAt: localDate(editing.checkInAt) }}
                field={{
                  name: "checkInAt",
                  label: t("labels.checkIn"),
                  type: "datetime-local",
                }}
              />
              <FormField
                row={{ checkOutAt: localDate(editing.checkOutAt) }}
                field={{
                  name: "checkOutAt",
                  label: t("labels.checkOut"),
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
                  label: t("labels.attendanceStatus"),
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
                <label htmlFor="correction-reason">
                  {t("reports.correctionReason")}
                </label>
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
                {t("common.cancel")}
              </button>
              <button
                disabled={busy || needsReconcile || isFetching}
                type="submit"
                className="button"
              >
                {busy ? t("common.saving") : t("reports.saveCorrection")}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
export function AdminSettings() {
  const t = useTranslations("admin");
  const errorMessage = useErrorMessage();
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
  const [message, setMessage] = useState<
    "" | "reports.corrected" | "settings.saved"
  >("");
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
      setMessage("settings.saved");
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
        eyebrow={t("settings.superAdmin")}
        title={t("settings.title")}
        description={t("settings.description")}
        action={<Refresh onClick={() => void refreshSettings()} />}
      />
      {isFetching && data && (
        <p className="muted" role="status">
          {t("common.refreshing")}
        </p>
      )}
      <ErrorNotice message={error || actionError} />
      {needsReconcile && <Notice>{t("settings.refreshBeforeChange")}</Notice>}
      {message && (
        <Notice notify>
          <Check size={16} />
          {t(message)}
        </Notice>
      )}
      {loading ? (
        <Loading />
      ) : data ? (
        <div className="stack">
          <section className="card">
            <div className="card-header">
              <div>
                <h2>{t("settings.organization")}</h2>
                <p>{t("settings.organizationDescription")}</p>
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
                    label: t("settings.organizationName"),
                    required: true,
                  }}
                />
                <FormField
                  row={organization}
                  field={{
                    name: "timezone",
                    label: t("settings.defaultTimezone"),
                    default: "UTC",
                    required: true,
                    hint: t("settings.timezoneHint"),
                  }}
                />
              </div>
              <div className="form-actions">
                <button
                  className="button"
                  disabled={!!busy || needsReconcile || isFetching}
                  type="submit"
                >
                  {busy === "organization"
                    ? t("common.saving")
                    : t("settings.saveOrganization")}
                </button>
              </div>
            </form>
          </section>
          <section className="card">
            <div className="card-header">
              <div>
                <h2>{t("settings.defaultPolicy")}</h2>
                <p>{t("settings.policyDescription")}</p>
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
                    label: t("labels.requirePasskey"),
                  },
                  {
                    name: "requireGeofence",
                    label: t("labels.requireLocation"),
                  },
                  {
                    name: "requireOfficeNetwork",
                    label: t("labels.requireNetwork"),
                  },
                  {
                    name: "requireApprovedDevice",
                    label: t("labels.requireDevice"),
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
                    label: t("labels.maximumGpsUncertainty"),
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
                    ? t("common.saving")
                    : t("settings.savePolicy")}
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
