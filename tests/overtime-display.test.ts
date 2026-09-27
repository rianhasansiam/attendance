import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { duration, Metric, Table } from "@/components/ui";

describe("signed overtime display", () => {
  it.each([
    [-90, "-1h 30m"],
    [-60, "-1h 0m"],
    [-30, "-0h 30m"],
    [-1, "-0h 1m"],
    [0, "0h 0m"],
    [30, "0h 30m"],
    [90, "1h 30m"],
  ])("formats %i minutes as %s", (minutes, expected) => {
    expect(duration(minutes)).toBe(expected);
  });

  it("keeps negative, zero and unknown overtime distinct in attendance tables", () => {
    const markup = renderToStaticMarkup(
      h(Table, {
        columns: [
          {
            key: "overtimeMinutes",
            label: "Overtime",
            format: "nullable-duration",
          },
        ],
        rows: [
          { id: "shortfall", overtimeMinutes: -30 },
          { id: "complete", overtimeMinutes: 0 },
          { id: "unknown", overtimeMinutes: null },
        ],
      }),
    );
    expect(markup.match(/<td>.*?<\/td>/g)).toEqual([
      "<td>-0h 30m</td>",
      "<td>0h 0m</td>",
      "<td>—</td>",
    ]);
  });

  it("shows a negative report total with one leading minus", () => {
    const markup = renderToStaticMarkup(
      h(Metric, {
        title: "Total overtime",
        value: duration(-90),
        note: "Across all matching attendance records.",
        icon: null,
      }),
    );
    expect(markup).toContain('class="stat-value">-1h 30m</div>');
  });
});
