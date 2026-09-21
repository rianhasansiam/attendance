"use client";

import Link from "next/link";
import { useCallback, useState, type FormEvent } from "react";
import type { startAuthentication } from "@simplewebauthn/browser";
import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  CalendarDays,
  Check,
  Clock3,
  Fingerprint,
  LogIn,
  LogOut,
  MapPin,
  Plus,
  ShieldCheck,
  Smartphone,
  Wifi,
} from "lucide-react";
import {
  Badge,
  date,
  duration,
  Empty,
  ErrorNotice,
  items,
  label,
  Loading,
  Metric,
  nested,
  Notice,
  PageHeader,
  Pagination,
  Refresh,
  Table,
  time,
  type DataRow,
} from "./ui";
import { api, useResource } from "./use-resource";
import { LateReasonDialog } from "./late-reason-dialog";

type EmployeeState = {
  employee: DataRow;
  shift: DataRow | null;
  today: DataRow | null;
  recent: DataRow[];
  devices: DataRow[];
  network: { verified: boolean | null };
  serverTime?: string;
  attendanceDate?: string;
};
const attendanceColumns = [
  { key: "attendanceDate", label: "Date", format: "date" as const },
  { key: "checkInAt", label: "Check in", format: "time" as const },
  { key: "checkOutAt", label: "Check out", format: "time" as const },
  { key: "workedMinutes", label: "Worked", format: "duration" as const },
  { key: "lateMinutes", label: "Late (min)" },
  { key: "lateReason", label: "Late reason", format: "text" as const },
  { key: "status", label: "Status", format: "badge" as const },
];
function getLocation(): Promise<{
  latitude: number;
  longitude: number;
  accuracy: number;
}> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation)
      return reject(
        new Error(
          "Location is unavailable in this browser. Use a supported browser with location enabled.",
        ),
      );
    navigator.geolocation.getCurrentPosition(
      ({ coords }) =>
        resolve({
          latitude: coords.latitude,
          longitude: coords.longitude,
          accuracy: coords.accuracy,
        }),
      (error) =>
        reject(
          new Error(
            error.code === 1
              ? "Location permission is required. Allow location access in your browser and try again."
              : "Your location could not be determined. Move near a window and try again.",
          ),
        ),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  });
}
function friendlyError(error: unknown) {
  if (error instanceof Error && error.name === "NotAllowedError")
    return "Device verification was cancelled or timed out. Please try again.";
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
export function EmployeeDashboard() {
  const { data, error, loading, refresh } =
    useResource<EmployeeState>("/api/attendance/me");
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [success, setSuccess] = useState("");
  const [submittedAttendance, setSubmittedAttendance] =
    useState<DataRow | null>(null);
  const [dismissedReasonId, setDismissedReasonId] = useState("");
  const [savedReasonId, setSavedReasonId] = useState("");
  const reasonAttendance = data?.today ?? submittedAttendance;
  const pendingReason =
    reasonAttendance?.id &&
    reasonAttendance.checkInAt &&
    Number(reasonAttendance.lateMinutes) > 0 &&
    !reasonAttendance.lateReason &&
    reasonAttendance.id !== savedReasonId
      ? reasonAttendance
      : null;
  const pendingReasonId = String(pendingReason?.id || "");
  const closeReason = useCallback(() => {
    setDismissedReasonId(pendingReasonId);
  }, [pendingReasonId]);
  const saveReason = useCallback(
    (record: DataRow) => {
      setSavedReasonId(String(record.id));
      setSubmittedAttendance(null);
      setSuccess("Your late attendance reason has been saved.");
      refresh();
    },
    [refresh],
  );
  const reasonDialog =
    pendingReason && dismissedReasonId !== pendingReasonId ? (
      <LateReasonDialog
        key={pendingReasonId}
        attendance={pendingReason}
        onClose={closeReason}
        onSaved={saveReason}
      />
    ) : null;
  async function attend(action: "CHECK_IN" | "CHECK_OUT") {
    setActionError("");
    setSuccess("");
    if (!navigator.onLine) {
      setActionError(
        "You’re offline. Connect to the internet to record attendance.",
      );
      return;
    }
    try {
      setBusy("Preparing verification…");
      const challenge = await api<{
        required?: boolean;
        challengeId?: string;
        options?: Parameters<typeof startAuthentication>[0]["optionsJSON"];
      }>("/api/webauthn/authenticate/options", {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      let response;
      if (challenge.required !== false && challenge.options) {
        setBusy("Verify with your registered device…");
        const { startAuthentication } = await import("@simplewebauthn/browser");
        response = await startAuthentication({
          optionsJSON: challenge.options,
        });
      }
      let location;
      if (
        nested(data?.employee || {}, "office.policy.requireGeofence") !== false
      ) {
        setBusy("Getting your location…");
        location = await getLocation();
      }
      setBusy("Recording your attendance…");
      const record = await api<DataRow>(
        `/api/attendance/${action === "CHECK_IN" ? "check-in" : "check-out"}`,
        {
          method: "POST",
          body: JSON.stringify({
            challengeId: challenge.challengeId,
            response,
            location,
          }),
        },
      );
      setSubmittedAttendance(record);
      if (action === "CHECK_IN") setDismissedReasonId("");
      setSuccess(
        action === "CHECK_IN"
          ? "You’re checked in. Have a good workday!"
          : "You’re checked out. Your attendance has been recorded.",
      );
      refresh();
    } catch (error) {
      setActionError(friendlyError(error));
    } finally {
      setBusy("");
    }
  }
  if (loading && !data)
    return (
      <>
        {reasonDialog}
        <Loading />
      </>
    );
  if (!data)
    return (
      <>
        <PageHeader title="My day" description="Your workday, at a glance." />
        <ErrorNotice message={error} />
        <Refresh onClick={refresh} />
        {reasonDialog}
      </>
    );
  const office = data.employee.office as DataRow;
  const policy = (office.policy || {}) as DataRow;
  const user = data.employee.user as DataRow;
  const today = data.today;
  const approved = data.devices.filter(
    (device) => device.approved && !device.revokedAt,
  );
  return (
    <>
      <PageHeader
        eyebrow="YOUR WORKDAY"
        title={`Hello, ${String(user?.name || "there").split(" ")[0]}.`}
        description="A fresh start. A clear view of your day."
        action={<Refresh onClick={refresh} />}
      />
      <ErrorNotice message={error || actionError} />
      {success && (
        <Notice>
          <Check size={17} />
          {success}
        </Notice>
      )}
      {pendingReason && (
        <div className="notice" role="status">
          <Clock3 size={17} />
          <span>Please add a reason for your late attendance.</span>
          <button
            type="button"
            className="button small secondary"
            onClick={() => setDismissedReasonId("")}
          >
            Add late reason
          </button>
        </div>
      )}
      {reasonDialog}
      <div className="content-grid">
        <div className="checkin-card">
          <p className="eyebrow">
            {today?.checkOutAt
              ? "WORKDAY COMPLETE"
              : today?.checkInAt
                ? "YOU’RE CHECKED IN"
                : "READY WHEN YOU ARE"}
          </p>
          <h2>
            {today?.checkOutAt
              ? "See you next workday."
              : today?.checkInAt
                ? "Make room for good work."
                : "Let’s start your day."}
          </h2>
          <p>
            {label(office?.name)}
            {data.shift
              ? ` · ${label(data.shift.startTime)} – ${label(data.shift.endTime)} · ${label(data.shift.timezone)}`
              : " · No active shift assigned"}
          </p>
          <div className="checkin-actions">
            <button
              className="button"
              disabled={!!busy || !!today?.checkInAt || !data.shift}
              onClick={() => attend("CHECK_IN")}
            >
              <LogIn size={17} />
              Check in
            </button>
            <button
              className="button secondary"
              disabled={!!busy || !today?.checkInAt || !!today?.checkOutAt}
              onClick={() => attend("CHECK_OUT")}
            >
              <LogOut size={17} />
              Check out
            </button>
          </div>
          {busy && <p role="status">{busy}</p>}
          <div className="today-metrics">
            <div>
              <span>CHECK IN</span>
              <strong>
                {time(today?.checkInAt, String(office?.timezone || "UTC"))}
              </strong>
            </div>
            <div>
              <span>CHECK OUT</span>
              <strong>
                {time(today?.checkOutAt, String(office?.timezone || "UTC"))}
              </strong>
            </div>
            <div>
              <span>WORKED</span>
              <strong>
                {today?.checkOutAt
                  ? duration(today.workedMinutes)
                  : "In progress" === today?.status
                    ? "In progress"
                    : today?.checkInAt
                      ? "In progress"
                      : "—"}
              </strong>
            </div>
          </div>
        </div>
        <section className="card">
          <div className="card-header">
            <h2>Attendance checks</h2>
            <ShieldCheck size={18} color="#8c9b85" />
          </div>
          <div className="card-body">
            <Verification
              icon={<Fingerprint size={18} />}
              title="Registered device"
              text={
                approved.length
                  ? `${approved.length} approved ${approved.length === 1 ? "device" : "devices"}`
                  : "Add a device to get started"
              }
              badge={approved.length ? "Verified" : "PENDING"}
            />
            <Verification
              icon={<MapPin size={18} />}
              title="Office location"
              text={
                policy.requireGeofence
                  ? "Location requested when you check in or out"
                  : "Not required by your office"
              }
              badge={
                policy.requireGeofence
                  ? "Checked on submission"
                  : "Not required"
              }
            />
            <Verification
              icon={<Wifi size={18} />}
              title="Office network"
              text={
                policy.requireOfficeNetwork
                  ? "Connect to an approved office network"
                  : "Not required by your office"
              }
              badge={
                data.network?.verified
                  ? "Verified"
                  : policy.requireOfficeNetwork
                    ? "Not verified"
                    : "Not required"
              }
            />
          </div>
        </section>
      </div>
      <div className="stats-grid">
        <Metric
          title="Today’s status"
          value={<Badge value={today?.status || "Not checked in"} />}
          note="Based on your office timezone"
          icon={<CalendarDays size={18} />}
        />
        <Metric
          title="Late arrival"
          value={`${Number(today?.lateMinutes || 0)} min`}
          note="Calculated from your assigned shift"
          icon={<Clock3 size={18} />}
        />
        <Metric
          title="Your department"
          value={label(nested(data.employee, "department.name"))}
          note={`Employee ID · ${label(data.employee.employeeCode)}`}
          icon={<Building2 size={18} />}
        />
        <Metric
          title="Assigned shift"
          value={label(data.shift?.name)}
          note={
            data.shift
              ? `${label(data.shift.startTime)} – ${label(data.shift.endTime)}`
              : "Contact your administrator"
          }
          icon={<Clock3 size={18} />}
        />
      </div>
      <section className="card">
        <div className="card-header">
          <div>
            <h2>Recent attendance</h2>
            <p>A little perspective on your workweek.</p>
          </div>
          <Link href="/employee/history" className="button-link">
            View history <ArrowUpRight size={15} />
          </Link>
        </div>
        <Table rows={data.recent || []} columns={attendanceColumns} />
      </section>
    </>
  );
}
function Verification({
  icon,
  title,
  text,
  badge,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
  badge: string;
}) {
  return (
    <div className="verification-item">
      <span className="verification-icon">{icon}</span>
      <div>
        <h3>{title}</h3>
        <p>{text}</p>
      </div>
      <Badge value={badge} />
    </div>
  );
}
export function EmployeeHistory() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const query = new URLSearchParams({
    page: String(page),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  });
  const { data, error, loading, refresh } = useResource<{
    records: DataRow[];
    total: number;
    pageSize: number;
  }>(`/api/attendance/history?${query}`);
  return (
    <>
      <PageHeader
        eyebrow="YOUR RECORDS"
        title="Attendance history"
        description="Every check-in, check-out, and workday in one place."
        action={<Refresh onClick={refresh} />}
      />
      <ErrorNotice message={error} />
      <section className="card">
        <div className="card-body">
          <div className="filter-grid">
            <div className="field">
              <label htmlFor="from">From date</label>
              <input
                id="from"
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="to">To date</label>
              <input
                id="to"
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPage(1);
                }}
              />
            </div>
          </div>
        </div>
        {loading ? (
          <Loading />
        ) : (
          <Table rows={items(data)} columns={attendanceColumns} />
        )}
        <Pagination
          page={page}
          pageSize={data?.pageSize || 50}
          total={data?.total || 0}
          loading={loading}
          onPage={setPage}
        />
      </section>
    </>
  );
}
export function EmployeeDevices() {
  const [page, setPage] = useState(1);
  const { data, error, loading, refresh } = useResource<{
    items: DataRow[];
    total: number;
    pageSize: number;
  }>(`/api/webauthn/devices?page=${page}`);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [success, setSuccess] = useState("");
  async function register(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setActionError("");
    setSuccess("");
    try {
      const challenge = await api<{
        challengeId: string;
        options: Parameters<typeof startRegistration>[0]["optionsJSON"];
      }>("/api/webauthn/register/options", { method: "POST", body: "{}" });
      const { startRegistration } = await import("@simplewebauthn/browser");
      const response = await startRegistration({
        optionsJSON: challenge.options,
      });
      await api("/api/webauthn/register/verify", {
        method: "POST",
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          response,
          name,
        }),
      });
      setSuccess(
        "Device registered. Your administrator may need to approve it before you record attendance.",
      );
      setName("");
      setPage(1);
      refresh();
    } catch (error) {
      setActionError(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    if (
      !window.confirm(
        "Revoke this device? It will no longer be able to verify attendance.",
      )
    )
      return;
    setBusy(true);
    setActionError("");
    try {
      await api("/api/webauthn/devices", {
        method: "DELETE",
        body: JSON.stringify({ id }),
      });
      refresh();
    } catch (error) {
      setActionError(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }
  const devices = items(data);
  return (
    <>
      <PageHeader
        eyebrow="SECURITY"
        title="My devices"
        description="A familiar device. An extra layer of confidence."
        action={<Refresh onClick={refresh} />}
      />
      <ErrorNotice message={error || actionError} />
      {success && <Notice>{success}</Notice>}
      <div className="content-grid">
        <section className="card">
          <div className="card-header">
            <div>
              <h2>Register a passkey</h2>
              <p>
                Use your device’s built-in verification to confirm attendance.
              </p>
            </div>
            <Fingerprint size={21} color="#8c9b85" />
          </div>
          <div className="card-body">
            <form onSubmit={register}>
              <div className="device-form">
                <div className="field">
                  <label htmlFor="device-name">Device name</label>
                  <input
                    required
                    maxLength={100}
                    id="device-name"
                    placeholder="e.g. My MacBook"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <button disabled={busy} className="button" type="submit">
                  <Plus size={16} />
                  {busy ? "Verifying…" : "Register device"}
                </button>
              </div>
            </form>
            <p className="muted" style={{ fontSize: 12 }}>
              Your fingerprint and face data stay on your device. Only a secure
              passkey is registered.
            </p>
          </div>
        </section>
        <section className="card">
          <div className="card-body">
            <ShieldCheck size={28} color="#7d9877" />
            <h2 style={{ marginTop: 15 }}>Designed for your privacy</h2>
            <p className="muted" style={{ marginTop: 10, fontSize: 12 }}>
              Google verifies your identity. Your approved passkey confirms
              attendance. Keep your registered devices up to date and revoke any
              you no longer use.
            </p>
          </div>
        </section>
      </div>
      <section className="card">
        <div className="card-header">
          <h2>Registered devices</h2>
          <span className="muted">{data?.total ?? 0}</span>
        </div>
        {loading ? (
          <Loading />
        ) : !devices.length ? (
          <Empty
            title="Your first device starts here"
            description="Register a passkey above to get ready for your next check-in."
          />
        ) : (
          devices.map((device) => (
            <div className="device-row" key={String(device.id)}>
              <div className="device-info">
                <span className="device-icon">
                  <Smartphone size={23} />
                </span>
                <div>
                  <h3>{label(device.name)}</h3>
                  <p>
                    Registered {date(device.createdAt)} ·{" "}
                    {label(device.deviceType)}
                  </p>
                </div>
              </div>
              <div className="row-actions">
                <Badge
                  value={
                    device.revokedAt
                      ? "REVOKED"
                      : device.approved
                        ? "APPROVED"
                        : "PENDING"
                  }
                />
                {!device.revokedAt && (
                  <button
                    disabled={busy}
                    className="button small secondary"
                    onClick={() => revoke(String(device.id))}
                  >
                    Revoke
                  </button>
                )}
              </div>
            </div>
          ))
        )}
        <Pagination
          page={page}
          total={data?.total ?? 0}
          pageSize={data?.pageSize ?? 25}
          loading={loading}
          onPage={setPage}
        />
      </section>
    </>
  );
}
export function EmployeeLeaves() {
  const [page, setPage] = useState(1);
  const { data, error, loading, refresh } = useResource<{
    items: DataRow[];
    total: number;
    pageSize: number;
  }>(`/api/employee/leaves?page=${page}`);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [success, setSuccess] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setActionError("");
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/employee/leaves", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(form)),
      });
      setShow(false);
      setPage(1);
      setSuccess("Leave request submitted for review.");
      refresh();
    } catch (error) {
      setActionError(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }
  async function cancel(id: string) {
    if (!window.confirm("Cancel this leave request?")) return;
    setBusy(true);
    setActionError("");
    setSuccess("");
    try {
      await api(`/api/employee/leaves/${id}`, { method: "DELETE" });
      setSuccess("Your leave request has been cancelled.");
      refresh();
    } catch (error) {
      setActionError(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="TIME AWAY"
        title="Leave requests"
        description="Plan a little space for life outside work."
        action={
          <button className="button" onClick={() => setShow(!show)}>
            <Plus size={16} />
            Request leave
          </button>
        }
      />
      <ErrorNotice message={error || (!show ? actionError : "")} />
      {success && <Notice>{success}</Notice>}
      {show && (
        <section className="card" style={{ marginBottom: 24 }}>
          <div className="card-header">
            <h2>New leave request</h2>
          </div>
          <form className="card-body" onSubmit={submit}>
            <ErrorNotice message={actionError} />
            <div className="form-grid">
              <div className="field">
                <label htmlFor="startDate">First day</label>
                <input required type="date" name="startDate" id="startDate" />
              </div>
              <div className="field">
                <label htmlFor="endDate">Last day</label>
                <input required type="date" name="endDate" id="endDate" />
              </div>
              <div className="field full">
                <label htmlFor="reason">Reason</label>
                <textarea
                  required
                  minLength={5}
                  maxLength={1000}
                  name="reason"
                  id="reason"
                  placeholder="Tell your team a little about your request."
                />
              </div>
            </div>
            <div className="form-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setShow(false)}
              >
                Cancel
              </button>
              <button disabled={busy} className="button" type="submit">
                {busy ? "Submitting…" : "Submit request"}
                <ArrowRight size={15} />
              </button>
            </div>
          </form>
        </section>
      )}
      <section className="card">
        <div className="card-header">
          <h2>Your requests</h2>
          <CalendarDays size={18} color="#8c9b85" />
        </div>
        {loading ? (
          <Loading />
        ) : (
          <Table
            rows={items(data)}
            columns={[
              { key: "startDate", label: "From", format: "date" },
              { key: "endDate", label: "To", format: "date" },
              { key: "reason", label: "Reason" },
              { key: "status", label: "Status", format: "badge" },
              { key: "reviewNote", label: "Review note" },
            ]}
            actions={(row) =>
              row.status === "PENDING" ? (
                <button
                  className="button small secondary"
                  disabled={busy}
                  onClick={() => cancel(String(row.id))}
                >
                  Cancel request
                </button>
              ) : null
            }
          />
        )}
        <Pagination
          page={page}
          pageSize={data?.pageSize || 25}
          total={data?.total || 0}
          loading={loading}
          onPage={setPage}
        />
      </section>
    </>
  );
}
