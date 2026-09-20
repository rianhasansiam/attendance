"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
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
import { Metric } from "./employee-workspace";
import {
  api,
  ErrorNotice,
  items,
  Loading,
  Notice,
  PageHeader,
  Refresh,
  Table,
  useResource,
  type DataRow,
} from "./ui";
import { FormField, Modal } from "./resource-workspace";

type DashboardData = {
  totalEmployees: number;
  presentToday: number;
  lateToday: number;
  absentToday: number;
  currentlyCheckedIn: number;
  checkedOut: number;
  recentAttendance: DataRow[];
  serverTime?: string;
};
export function AdminDashboard() {
  const { data, error, loading, refresh } = useResource<DashboardData>(
    "/api/admin/dashboard",
  );
  return (
    <>
      <PageHeader
        eyebrow="YOUR WORKPLACE, AT A GLANCE"
        title="A good day starts here."
        description="A little clarity on your people and their workday."
        action={
          <Link className="button" href="/admin/reports">
            <Download size={15} />
            View reports
          </Link>
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
              note="Arrivals beyond shift grace time"
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
                  <p>A live perspective on the workday.</p>
                </div>
                <span className="badge green">Live overview</span>
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
                { key: "status", label: "Status", format: "badge" },
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
  { key: "lateMinutes", label: "Late (min)" },
  { key: "status", label: "Status", format: "badge" as const },
];
export function AdminReports({
  attendance = false,
  employeeId = "",
}: {
  attendance?: boolean;
  employeeId?: string;
}) {
  const [filters, setFilters] = useState<Record<string, string>>(
    employeeId ? { employeeId } : {},
  );
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<DataRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const query = new URLSearchParams({
    ...filters,
    page: String(page),
    pageSize: "25",
  });
  const { data, error, loading, refresh } = useResource<{
    items: DataRow[];
    total: number;
  }>(`/api/admin/reports?${query}`);
  function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setFilters(
      Object.fromEntries(
        [...form.entries()]
          .filter(([key, value]) => key !== "" && value !== "")
          .map(([key, value]) => [key, String(value)]),
      ),
    );
    setPage(1);
  }
  async function correct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setActionError("");
    const form = new FormData(event.currentTarget);
    const payload: DataRow = {
      reason: form.get("reason"),
      status: form.get("status"),
    };
    for (const field of ["checkInAt", "checkOutAt"]) {
      const value = String(form.get(field) || "");
      payload[field] = value ? new Date(value).toISOString() : null;
    }
    try {
      if (editing?.derived) {
        payload.employeeId = (editing.employee as DataRow).id;
        payload.attendanceDate = String(editing.attendanceDate).slice(0, 10);
      }
      await api(
        `/api/admin/attendance${editing?.derived ? "" : `/${editing?.id}`}`,
        {
          method: editing?.derived ? "POST" : "PATCH",
          body: JSON.stringify(payload),
        },
      );
      setEditing(null);
      setMessage(
        "Attendance updated. The correction has been added to the audit log.",
      );
      refresh();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Unable to save correction.",
      );
    } finally {
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
          <div className="header-actions">
            <a
              className="button secondary"
              href={`/api/admin/reports?${query}&format=csv`}
            >
              <Download size={15} />
              CSV
            </a>
            <a
              className="button"
              href={`/api/admin/reports?${query}&format=xlsx`}
            >
              <Download size={15} />
              Excel
            </a>
          </div>
        }
      />
      <ErrorNotice message={error || (!editing ? actionError : "")} />
      {message && <Notice>{message}</Notice>}
      <section className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <div>
            <h2>Find the right perspective</h2>
            <p>Filter up to 93 days. The last 30 days are shown by default.</p>
          </div>
        </div>
        <form className="card-body" onSubmit={filter}>
          <div className="filter-grid">
            <FormField
              row={{ employeeId }}
              field={{
                name: "employeeId",
                label: "Employee",
                resource: "employees",
              }}
            />
            <FormField
              row={{}}
              field={{
                name: "departmentId",
                label: "Department",
                resource: "departments",
              }}
            />
            <FormField
              row={{}}
              field={{ name: "officeId", label: "Office", resource: "offices" }}
            />
            <FormField
              row={{}}
              field={{ name: "shiftId", label: "Shift", resource: "shifts" }}
            />
            <FormField
              row={{}}
              field={{ name: "from", label: "From date", type: "date" }}
            />
            <FormField
              row={{}}
              field={{ name: "to", label: "To date", type: "date" }}
            />
            <div className="field">
              <label htmlFor="status-filter">Status</label>
              <select id="status-filter" name="status">
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
              <button
                type="reset"
                className="button secondary"
                onClick={() => {
                  setFilters({});
                  setPage(1);
                }}
              >
                Reset
              </button>
            </div>
          </div>
        </form>
      </section>
      <section className="card">
        <div className="card-header">
          <h2>{attendance ? "Attendance records" : "Report results"}</h2>
          <span className="muted" style={{ fontSize: 12 }}>
            {data?.total || 0} records
          </span>
        </div>
        {loading ? (
          <Loading />
        ) : (
          <Table
            rows={items(data)}
            columns={reportColumns}
            actions={
              attendance
                ? (row) => (
                    <button
                      aria-label="Correct attendance"
                      className="icon-button"
                      onClick={() => {
                        setEditing(row);
                        setActionError("");
                      }}
                    >
                      <Pencil size={15} />
                    </button>
                  )
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
      {editing && (
        <Modal
          title="Correct attendance"
          close={() => {
            if (!busy) setEditing(null);
          }}
        >
          <form onSubmit={correct}>
            <ErrorNotice message={actionError} />
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
                row={editing}
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
              <button disabled={busy} type="submit" className="button">
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
  const { data, error, loading, refresh } = useResource<unknown>(
    "/api/admin/settings",
  );
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const settings = items(data);
  const organization = (settings.find((row) => row.key === "organization")
    ?.value || {}) as DataRow;
  const policy = (settings.find((row) => row.key === "attendance.defaultPolicy")
    ?.value || {}) as DataRow;
  async function save(event: FormEvent<HTMLFormElement>, key: string) {
    event.preventDefault();
    setBusy(key);
    setActionError("");
    setMessage("");
    const form = new FormData(event.currentTarget);
    const value: DataRow =
      key === "organization"
        ? { name: form.get("name"), timezone: form.get("timezone") }
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
      await api("/api/admin/settings", {
        method: "POST",
        body: JSON.stringify({ key, value }),
      });
      setMessage("Workspace settings saved.");
      refresh();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Unable to save settings.",
      );
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="SUPER ADMIN"
        title="Workspace settings"
        description="A secure foundation for your organization."
      />
      <ErrorNotice message={error || actionError} />
      {message && (
        <Notice>
          <Check size={16} />
          {message}
        </Notice>
      )}
      {loading ? (
        <Loading />
      ) : (
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
                <button className="button" disabled={!!busy} type="submit">
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
                <button className="button" disabled={!!busy} type="submit">
                  {busy === "attendance.defaultPolicy"
                    ? "Saving…"
                    : "Save attendance policy"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
