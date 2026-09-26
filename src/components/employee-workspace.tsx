"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
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
  AttendanceStatus,
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
import { confirmAction } from "@/lib/client/alerts";
import { baseApi } from "@/store/api/base-api";
import { errorMessage } from "@/store/api/errors";
import { useAppDispatch, useAppStore } from "@/store/hooks";
import { useQueryView } from "@/store/use-query-view";
import { useFreshness } from "@/store/freshness";
import {
  applyConfirmedAttendance,
  attendanceApi,
  attendanceChangedTags,
  devicesChangedTags,
  useEmployeeDayQuery,
  useEmployeeHistoryQuery,
  useEmployeeDevicesQuery,
  useRevokeEmployeeDeviceMutation,
} from "@/store/features/attendance/api";
import {
  useEmployeeLeavesQuery,
  useCreateEmployeeLeaveMutation,
  useCancelEmployeeLeaveMutation,
} from "@/store/features/leave/api";
import {
  recordAttendance,
  registerDevice,
  UncertainCeremonyError,
  isAmbiguousWrite,
} from "@/lib/client/attendance-ceremony";
import { useUrlFilters, pageFromSearch } from "@/lib/client/use-url-filters";
import { LateReasonDialog } from "./late-reason-dialog";
import {
  beginAttendanceTiming,
  type AttendanceTimingTrace,
} from "@/lib/client/attendance-timing";
import {
  attendanceIntent,
  recoveredAttendance,
  type AttendanceIntent,
} from "@/lib/client/attendance-recovery";
import type { AttendanceRecord } from "@/store/features/attendance/contracts";

type AttendanceAttempt = {
  controller: AbortController;
  intent: AttendanceIntent;
  timing: AttendanceTimingTrace;
};

const attendanceColumns = [
  { key: "attendanceDate", label: "Date", format: "date" as const },
  { key: "checkInAt", label: "Check in", format: "time" as const },
  { key: "checkOutAt", label: "Check out", format: "time" as const },
  { key: "workedMinutes", label: "Worked", format: "duration" as const },
  {
    key: "overtimeMinutes",
    label: "Overtime",
    format: "nullable-duration" as const,
  },
  { key: "lateMinutes", label: "Actual late (min)" },
  { key: "lateReason", label: "Late reason", format: "text" as const },
  { key: "status", label: "Status", format: "attendance-status" as const },
];
function friendlyError(error: unknown) {
  if (error instanceof Error && error.name === "NotAllowedError")
    return "Device verification was cancelled or timed out. Please try again.";
  return errorMessage(error);
}
export function EmployeeDashboard() {
  const dispatch = useAppDispatch();
  const store = useAppStore();
  const dayQuery = useEmployeeDayQuery(undefined, useFreshness(true));
  const { data, error, loading, refresh, isFetching } = useQueryView(dayQuery);
  const submitting = useRef(false);
  const attempt = useRef<AttendanceAttempt | null>(null);
  const recovery = useRef<AttendanceAttempt | null>(null);
  const [busy, setBusy] = useState("");
  useEffect(
    () => () => {
      attempt.current?.controller.abort();
      attempt.current?.timing.finish("cancelled");
      // Activity can hide this route without discarding component state.
      // Clear transient work so a revealed dashboard is not stuck as busy.
      submitting.current = false;
      setBusy("");
    },
    [],
  );
  const [needsReconcile, setNeedsReconcile] = useState(false);
  const [visibleConfirmation, setVisibleConfirmation] = useState<{
    record: AttendanceRecord;
    attempt: AttendanceAttempt;
    outcome: "confirmed" | "recovered";
  }>();
  function isCurrent(current: AttendanceAttempt) {
    return (
      attempt.current === current &&
      !current.controller.signal.aborted &&
      store.getState().workspaceUi.status === "active"
    );
  }
  useEffect(() => {
    if (!visibleConfirmation || busy) return;
    const { record, attempt: current, outcome } = visibleConfirmation;
    if (
      !current.controller.signal.aborted &&
      store.getState().workspaceUi.status === "active" &&
      data?.today?.id === record.id &&
      data?.today?.checkInAt === record.checkInAt &&
      data?.today?.checkOutAt === record.checkOutAt
    ) {
      // Measure the committed React display, not just receipt of the POST.
      current.timing.finish(outcome);
    }
  }, [visibleConfirmation, busy, data?.today, store]);
  async function refreshDay() {
    let pending = recovery.current;
    if (
      pending?.controller.signal.aborted &&
      attempt.current === pending &&
      store.getState().workspaceUi.status === "active"
    ) {
      // Resume only the authoritative read after a retained route is revealed;
      // the cancelled attendance request and its evidence are never replayed.
      pending = {
        ...pending,
        controller: new AbortController(),
        timing: beginAttendanceTiming(pending.intent.action),
      };
      recovery.current = pending;
      attempt.current = pending;
    }
    if (pending && !isCurrent(pending)) return;
    if (pending) setBusy("Checking the latest attendance…");
    try {
      if (pending) {
        // A read that began before the uncertain write is not a recovery read.
        const running = dispatch(
          attendanceApi.util.getRunningQueryThunk("employeeDay", undefined),
        );
        if (running) {
          running.abort();
          await running;
        }
        if (!isCurrent(pending)) return;
      }
      const read = () => refresh().unwrap();
      const day = pending
        ? await pending.timing.measure("recovery", read)
        : await read();
      if (!pending) return;
      if (!isCurrent(pending)) return;
      const record = recoveredAttendance(day, pending.intent);
      if (!record) {
        setActionError(
          "The latest attendance does not yet confirm this action. Refresh again before another attempt.",
        );
        return;
      }
      const applied = await dispatch(
        applyConfirmedAttendance(
          record,
          pending.intent.employeeId,
          pending.controller.signal,
        ),
      );
      if (!applied || !isCurrent(pending)) return;
      recovery.current = null;
      setNeedsReconcile(false);
      setActionError("");
      setSuccess(
        pending.intent.action === "CHECK_IN"
          ? "You’re checked in. Your attendance was confirmed after refreshing."
          : "You’re checked out. Your attendance was confirmed after refreshing.",
      );
      setVisibleConfirmation({
        record,
        attempt: pending,
        outcome: "recovered",
      });
      dispatch(baseApi.util.invalidateTags([...attendanceChangedTags]));
    } catch {
      // Keep the operation disabled until an authoritative read succeeds.
    } finally {
      if (pending && isCurrent(pending)) setBusy("");
    }
  }
  const [actionError, setActionError] = useState("");
  const [success, setSuccess] = useState("");
  const [dismissedReasonId, setDismissedReasonId] = useState("");
  const [savedReasonId, setSavedReasonId] = useState("");
  const reasonAttendance = data?.today;
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
  const saveReason = useCallback((record: DataRow) => {
    setSavedReasonId(String(record.id));
    setSuccess(
      record.lateApprovalStatus
        ? "Your late attendance reason has been saved and approval requested."
        : "Your late attendance reason has been saved.",
    );
  }, []);
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
    if (submitting.current || needsReconcile || !data) return;
    const timing = beginAttendanceTiming(action);
    setActionError("");
    setSuccess("");
    if (!navigator.onLine) {
      setActionError(
        "You’re offline. Connect to the internet to record attendance.",
      );
      timing.finish("failed");
      return;
    }
    submitting.current = true;
    const controller = new AbortController();
    const current: AttendanceAttempt = {
      controller,
      intent: attendanceIntent(action, data),
      timing,
    };
    attempt.current = current;
    setBusy("Preparing verification…");
    try {
      const record = await recordAttendance({
        action,
        timing,
        progress: (message) => {
          if (isCurrent(current)) setBusy(message);
        },
        signal: controller.signal,
      });
      if (!isCurrent(current)) return;
      const applied = await dispatch(
        applyConfirmedAttendance(
          record,
          current.intent.employeeId,
          controller.signal,
        ),
      );
      if (!applied || !isCurrent(current)) return;
      if (action === "CHECK_IN") setDismissedReasonId("");
      setSuccess(
        action === "CHECK_IN"
          ? "You’re checked in. Have a good workday!"
          : "You’re checked out. Your attendance has been recorded.",
      );
      setVisibleConfirmation({
        record,
        attempt: current,
        outcome: "confirmed",
      });
      dispatch(baseApi.util.invalidateTags([...attendanceChangedTags]));
    } catch (error) {
      if (!isCurrent(current)) {
        timing.finish("cancelled");
        return;
      }
      setActionError(friendlyError(error));
      if (error instanceof UncertainCeremonyError) {
        recovery.current = current;
        setNeedsReconcile(true);
        await refreshDay();
      } else timing.finish("failed");
    } finally {
      if (attempt.current === current) {
        submitting.current = false;
        if (isCurrent(current)) setBusy("");
      }
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
        <Refresh onClick={() => void refreshDay()} />
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
        action={<Refresh onClick={() => void refreshDay()} />}
      />
      <ErrorNotice message={error || actionError} />
      {isFetching && data && (
        <p className="muted" role="status">
          Refreshing attendance…
        </p>
      )}
      {needsReconcile && (
        <Notice>
          Refresh attendance to confirm the previous action before trying again.
        </Notice>
      )}
      {success && (
        <Notice notify>
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
              disabled={
                !!busy ||
                needsReconcile ||
                isFetching ||
                !!today?.checkInAt ||
                !data.shift
              }
              onClick={() => attend("CHECK_IN")}
            >
              <LogIn size={17} />
              Check in
            </button>
            <button
              className="button secondary"
              disabled={
                !!busy ||
                needsReconcile ||
                isFetching ||
                !today?.checkInAt ||
                !!today?.checkOutAt
              }
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
          value={
            <AttendanceStatus record={today || { status: "Not checked in" }} />
          }
          note="Effective status used in attendance reports"
          icon={<CalendarDays size={18} />}
        />
        <Metric
          title="Actual late arrival"
          value={`${Number(today?.lateMinutes || 0)} min`}
          note={
            today?.isExcusedLate
              ? "Excused; actual arrival retained"
              : "Calculated from your assigned shift"
          }
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
  const { params, update } = useUrlFilters();
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  const page = pageFromSearch(params.get("page"), 10000);
  const setPage = (page: number) => update({ page });
  const historyQuery = useEmployeeHistoryQuery(
    { page, ...(from ? { from } : {}), ...(to ? { to } : {}) },
    useFreshness(),
  );
  const { data, error, loading, refresh, isFetching } =
    useQueryView(historyQuery);
  return (
    <>
      <PageHeader
        eyebrow="YOUR RECORDS"
        title="Attendance history"
        description="Every check-in, check-out, and workday in one place."
        action={<Refresh onClick={refresh} />}
      />
      <ErrorNotice message={error} />
      {isFetching && data && (
        <p className="muted" role="status">
          Refreshing records…
        </p>
      )}
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
                  update({ from: e.target.value, page: 1 });
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
                  update({ to: e.target.value, page: 1 });
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
  const dispatch = useAppDispatch();
  const { params, update } = useUrlFilters();
  const page = pageFromSearch(params.get("page"));
  const setPage = (page: number) => update({ page });
  const devicesQuery = useEmployeeDevicesQuery({ page }, useFreshness());
  const { data, error, loading, refresh, isFetching } =
    useQueryView(devicesQuery);
  const [revokeDevice] = useRevokeEmployeeDeviceMutation();
  const submitting = useRef(false);
  const ceremony = useRef<AbortController | null>(null);
  useEffect(() => () => ceremony.current?.abort(), []);
  const [needsReconcile, setNeedsReconcile] = useState(false);
  async function refreshDevices() {
    try {
      await refresh().unwrap();
      setNeedsReconcile(false);
    } catch {
      // Do not offer another write while the preceding outcome is unknown.
    }
  }
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [success, setSuccess] = useState("");
  async function register(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || needsReconcile) return;
    submitting.current = true;
    const controller = new AbortController();
    ceremony.current = controller;
    setBusy(true);
    setActionError("");
    setSuccess("");
    try {
      await registerDevice(name, controller.signal);
      controller.signal.throwIfAborted();
      setSuccess(
        "Device registered. Your administrator may need to approve it before you record attendance.",
      );
      setName("");
      setPage(1);
      dispatch(baseApi.util.invalidateTags([...devicesChangedTags]));
    } catch (error) {
      if (controller.signal.aborted) return;
      setActionError(friendlyError(error));
      if (error instanceof UncertainCeremonyError) {
        setNeedsReconcile(true);
        await refreshDevices();
      }
    } finally {
      if (ceremony.current === controller) {
        ceremony.current = null;
        submitting.current = false;
        setBusy(false);
      }
    }
  }
  async function revoke(id: string) {
    if (submitting.current || needsReconcile) return;
    submitting.current = true;
    setBusy(true);
    try {
      if (
        !(await confirmAction({
          title: "Revoke this device?",
          text: "It will no longer be able to verify attendance.",
          confirmText: "Revoke device",
          danger: true,
        }))
      )
        return;
      setActionError("");
      setSuccess("");
      await revokeDevice(id).unwrap();
      setSuccess("Device revoked successfully.");
    } catch (error) {
      setActionError(friendlyError(error));
      if (isAmbiguousWrite(error)) {
        setNeedsReconcile(true);
        await refreshDevices();
      }
    } finally {
      submitting.current = false;
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
        action={<Refresh onClick={() => void refreshDevices()} />}
      />
      <ErrorNotice message={error || actionError} />
      {isFetching && data && (
        <p className="muted" role="status">
          Refreshing devices…
        </p>
      )}
      {needsReconcile && (
        <Notice>Refresh devices successfully before trying again.</Notice>
      )}
      {success && <Notice notify>{success}</Notice>}
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
                <button
                  disabled={busy || needsReconcile}
                  className="button"
                  type="submit"
                >
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
              Your sign-in verifies your identity. Your approved passkey
              confirms attendance. Keep your registered devices up to date and
              revoke any you no longer use.
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
                    disabled={busy || needsReconcile}
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
  const { params, update } = useUrlFilters();
  const page = pageFromSearch(params.get("page"));
  const setPage = (page: number) => update({ page });
  const leavesQuery = useEmployeeLeavesQuery({ page }, useFreshness());
  const { data, error, loading, refresh, isFetching } =
    useQueryView(leavesQuery);
  const [createLeave] = useCreateEmployeeLeaveMutation();
  const [cancelLeave] = useCancelEmployeeLeaveMutation();
  const submitting = useRef(false);
  const [needsReconcile, setNeedsReconcile] = useState(false);
  async function refreshLeaves() {
    try {
      await refresh().unwrap();
      setNeedsReconcile(false);
    } catch {
      // An uncertain write must be reconciled before another submission.
    }
  }
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [success, setSuccess] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || needsReconcile) return;
    submitting.current = true;
    setBusy(true);
    setActionError("");
    const form = new FormData(event.currentTarget);
    try {
      await createLeave({
        startDate: String(form.get("startDate") || ""),
        endDate: String(form.get("endDate") || ""),
        reason: String(form.get("reason") || ""),
      }).unwrap();
      setShow(false);
      setPage(1);
      setSuccess("Leave request submitted for review.");
    } catch (error) {
      setActionError(friendlyError(error));
      if (isAmbiguousWrite(error)) {
        setNeedsReconcile(true);
        await refreshLeaves();
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  async function cancel(id: string) {
    if (submitting.current || needsReconcile) return;
    submitting.current = true;
    setBusy(true);
    try {
      if (
        !(await confirmAction({
          title: "Cancel this leave request?",
          text: "The request will be marked as cancelled.",
          confirmText: "Cancel request",
          cancelText: "Keep request",
          danger: true,
        }))
      )
        return;
      setActionError("");
      setSuccess("");
      await cancelLeave(id).unwrap();
      setSuccess("Your leave request has been cancelled.");
    } catch (error) {
      setActionError(friendlyError(error));
      if (isAmbiguousWrite(error)) {
        setNeedsReconcile(true);
        await refreshLeaves();
      }
    } finally {
      submitting.current = false;
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
          <div className="page-header-actions">
            <Refresh onClick={() => void refreshLeaves()} />
            <button className="button" onClick={() => setShow(!show)}>
              <Plus size={16} />
              Request leave
            </button>
          </div>
        }
      />
      <ErrorNotice message={error || (!show ? actionError : "")} />
      {isFetching && data && (
        <p className="muted" role="status">
          Refreshing leave requests…
        </p>
      )}
      {needsReconcile && (
        <Notice>
          Refresh leave requests successfully before trying again.
        </Notice>
      )}
      {success && <Notice notify>{success}</Notice>}
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
              <button
                disabled={busy || needsReconcile}
                className="button"
                type="submit"
              >
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
                  disabled={busy || needsReconcile}
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
