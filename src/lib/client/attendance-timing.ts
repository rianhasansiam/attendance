"use client";

type AttendanceAction = "CHECK_IN" | "CHECK_OUT";
type TimingStage =
  "options" | "passkey" | "gps" | "gps-refresh" | "post" | "recovery";
type TimingOutcome =
  "confirmed" | "recovered" | "failed" | "cancelled" | "uncertain";

export type AttendanceTimingTrace = {
  enabled: boolean;
  headers: Record<string, string> | undefined;
  measure<T>(stage: TimingStage, run: () => Promise<T>): Promise<T>;
  mark(name: "post-confirmed"): void;
  finish(outcome: TimingOutcome): void;
};

const stages = new Set<TimingStage>([
  "options",
  "passkey",
  "gps",
  "gps-refresh",
  "post",
  "recovery",
]);
const outcomes = new Set<TimingOutcome>([
  "confirmed",
  "recovered",
  "failed",
  "cancelled",
  "uncertain",
]);
const disabledTrace: AttendanceTimingTrace = {
  enabled: false,
  headers: undefined,
  measure: (_stage, run) => run(),
  mark: () => {},
  finish: () => {},
};

/** Local, opt-in diagnostics. Never accepts evidence, records, errors or identity. */
export function beginAttendanceTiming(
  action: AttendanceAction,
): AttendanceTimingTrace {
  if (
    typeof window === "undefined" ||
    (action !== "CHECK_IN" && action !== "CHECK_OUT") ||
    (new URLSearchParams(window.location.search).get("attendanceTiming") !==
      "1" &&
      (window as Window & { __ATTENDANCE_TIMING__?: boolean })
        .__ATTENDANCE_TIMING__ !== true)
  )
    return disabledTrace;

  const started = performance.now();
  const traceId = crypto.randomUUID();
  const spans: { stage: TimingStage; startMs: number; durationMs: number }[] =
    [];
  let confirmedAt: number | undefined;
  let finished = false;
  const duration = (value: number) =>
    Number.isFinite(value) ? Math.round(Math.max(0, value) * 100) / 100 : 0;

  return {
    enabled: true,
    headers: { "x-attendance-timing": "1" },
    async measure(stage, run) {
      const start = performance.now();
      try {
        return await run();
      } finally {
        if (!finished && stages.has(stage))
          spans.push({
            stage,
            startMs: duration(start - started),
            durationMs: duration(performance.now() - start),
          });
      }
    },
    mark(name) {
      if (!finished && name === "post-confirmed")
        confirmedAt = performance.now();
    },
    finish(outcome) {
      if (finished || !outcomes.has(outcome)) return;
      finished = true;
      const now = performance.now();
      // Stage offsets distinguish overlapping spans from total wall-clock time.
      // The explicit allowlist prevents accidental evidence/DTO/error logging.
      console.info("[attendance-timing]", {
        traceId,
        action,
        outcome,
        wallMs: duration(now - started),
        ...(outcome === "confirmed" && confirmedAt !== undefined
          ? { postToVisibleMs: duration(now - confirmedAt) }
          : {}),
        spans: [...spans],
      });
    },
  };
}
