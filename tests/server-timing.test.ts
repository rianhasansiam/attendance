import { afterEach, describe, expect, it, vi } from "vitest";
import {
  measureServerTiming,
  requestServerTiming,
  ServerTiming,
} from "../src/lib/server-timing";

afterEach(() => vi.restoreAllMocks());

describe("opt-in attendance server timing", () => {
  it.each([undefined, "0", "true", "1, 1"])(
    "does not sample without exact opt-in (%s)",
    async (value) => {
      const clock = vi.spyOn(performance, "now");
      const headers = new Headers();
      if (value !== undefined) headers.set("x-attendance-timing", value);
      const timing = requestServerTiming(
        new Request("https://example.com", { headers }),
      );
      expect(timing).toBeUndefined();
      expect(await measureServerTiming(timing, "auth", async () => "ok")).toBe(
        "ok",
      );
      expect(clock).not.toHaveBeenCalled();
    },
  );

  it("reports only fixed timing names and milliseconds, with overlapping phases separate from total", async () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const timing = requestServerTiming(
      new Request("https://example.com", {
        headers: {
          "x-attendance-timing": "1",
          "x-request-id": "private-input",
        },
      }),
    )!;
    const transaction = timing.start("transaction");
    now = 110;
    await measureServerTiming(timing, "authoritative_reads", async () => {
      now = 120;
    });
    await measureServerTiming(timing, "authoritative_reads", async () => {
      now = 125;
    });
    now = 140;
    transaction();
    transaction(); // Finishing a span twice cannot double count it.
    now = 150;
    const response = timing.apply(
      Response.json(
        { success: true },
        {
          headers: { "Cache-Control": "no-store" },
        },
      ),
    );
    expect(response.headers.get("server-timing")).toBe(
      "authoritative_reads;dur=15.0, transaction;dur=40.0, total;dur=50.0",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ success: true });
    expect(Array.from(response.headers).join()).not.toContain("private-input");
  });

  it("records failed phases while preserving the original rejection", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const timing = new ServerTiming();
    const error = new Error("private verification details");
    await expect(
      measureServerTiming(timing, "verification", async () => {
        now = 25;
        throw error;
      }),
    ).rejects.toBe(error);
    expect(timing.apply(new Response()).headers.get("server-timing")).toBe(
      "verification;dur=25.0, total;dur=25.0",
    );
  });
});
