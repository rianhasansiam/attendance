import "server-only";

// Fixed names prevent user-provided data from reaching the timing header.
type TimingPhase =
  | "auth"
  | "rate_limit"
  | "initial_policy"
  | "challenge"
  | "tx_acquire"
  | "employee_lock"
  | "authoritative_reads"
  | "verification"
  | "db_write"
  | "tx_finish"
  | "transaction"
  | "total";

export class ServerTiming {
  private readonly durations = new Map<TimingPhase, number>();
  private readonly startedAt = performance.now();

  start(phase: TimingPhase) {
    const startedAt = performance.now();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.durations.set(
        phase,
        (this.durations.get(phase) ?? 0) + performance.now() - startedAt,
      );
    };
  }

  apply(response: Response) {
    this.durations.set("total", performance.now() - this.startedAt);
    response.headers.set(
      "Server-Timing",
      Array.from(
        this.durations,
        ([phase, duration]) =>
          `${phase};dur=${Math.max(0, duration).toFixed(1)}`,
      ).join(", "),
    );
    return response;
  }
}

export function requestServerTiming(request: Request) {
  return request.headers.get("x-attendance-timing") === "1"
    ? new ServerTiming()
    : undefined;
}

export async function measureServerTiming<T>(
  timing: ServerTiming | undefined,
  phase: TimingPhase,
  operation: () => T | PromiseLike<T>,
): Promise<T> {
  const finish = timing?.start(phase);
  try {
    return await operation();
  } finally {
    finish?.();
  }
}
