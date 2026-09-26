// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginAttendanceTiming } from "@/lib/client/attendance-timing";

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
  delete (window as Window & { __ATTENDANCE_TIMING__?: boolean })
    .__ATTENDANCE_TIMING__;
});

describe("opt-in attendance timing", () => {
  it("does not measure or log when disabled", async () => {
    const clock = vi.spyOn(performance, "now");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const trace = beginAttendanceTiming("CHECK_IN");
    expect(trace.enabled).toBe(false);
    expect(trace.headers).toBeUndefined();
    await expect(trace.measure("post", async () => "result")).resolves.toBe(
      "result",
    );
    trace.mark("post-confirmed");
    trace.finish("confirmed");
    expect(clock).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("reports overlapping stage offsets separately from wall time and post-to-visible", async () => {
    window.history.replaceState(null, "", "/?attendanceTiming=1");
    let now = 10;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const trace = beginAttendanceTiming("CHECK_OUT");
    let finishPasskey!: () => void;
    const passkey = trace.measure(
      "passkey",
      () =>
        new Promise<void>((resolve) => {
          finishPasskey = resolve;
        }),
    );
    now = 20;
    await trace.measure("gps", async () => {
      now = 40;
    });
    now = 50;
    finishPasskey();
    await passkey;
    await trace.measure("post", async () => {
      now = 70;
    });
    trace.mark("post-confirmed");
    now = 76;
    trace.finish("confirmed");
    trace.finish("failed");
    expect(log).toHaveBeenCalledExactlyOnceWith("[attendance-timing]", {
      traceId: expect.any(String),
      action: "CHECK_OUT",
      outcome: "confirmed",
      wallMs: 66,
      postToVisibleMs: 6,
      spans: [
        { stage: "gps", startMs: 10, durationMs: 20 },
        { stage: "passkey", startMs: 0, durationMs: 40 },
        { stage: "post", startMs: 40, durationMs: 20 },
      ],
    });
  });

  it("supports a temporary browser flag, preserves failures and never logs their contents", async () => {
    (
      window as Window & { __ATTENDANCE_TIMING__?: boolean }
    ).__ATTENDANCE_TIMING__ = true;
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const trace = beginAttendanceTiming("CHECK_IN");
    const error = new Error("private-session-secret");
    await expect(
      trace.measure("passkey", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    trace.finish("failed");
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "private-session-secret",
    );
    expect(log.mock.calls[0][1]).not.toHaveProperty("postToVisibleMs");
  });

  it("uses distinct random trace IDs and emits only finite nonnegative durations", async () => {
    window.history.replaceState(null, "", "/?attendanceTiming=1");
    vi.spyOn(performance, "now").mockReturnValue(Number.NaN);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    for (let i = 0; i < 2; i++) {
      const trace = beginAttendanceTiming("CHECK_IN");
      await trace.measure("options", async () => undefined);
      trace.mark("post-confirmed");
      trace.finish("confirmed");
    }
    const first = log.mock.calls[0][1];
    const second = log.mock.calls[1][1];
    expect(first.traceId).not.toBe(second.traceId);
    expect(first).toMatchObject({
      wallMs: 0,
      postToVisibleMs: 0,
      spans: [{ startMs: 0, durationMs: 0 }],
    });
  });

  it("ignores unexpected runtime stage labels and does not retain late spans", async () => {
    window.history.replaceState(null, "", "/?attendanceTiming=1");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const trace = beginAttendanceTiming("CHECK_IN");
    await trace.measure("private-payload" as "gps", async () => ({
      secret: "private-payload",
    }));
    trace.finish("cancelled");
    await trace.measure("gps", async () => undefined);
    expect(log.mock.calls[0][1].spans).toEqual([]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-payload");
  });
});
