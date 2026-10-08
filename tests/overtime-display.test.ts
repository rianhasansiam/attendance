import { createElement as h } from "react";
import { NextIntlClientProvider } from "next-intl";
import { testMessages } from "./i18n-root";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
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

  it("keeps signed durations visible and colors them using the inclusive 30-minute threshold", () => {
    const markup = renderToStaticMarkup(
      h(Table, {
        columns: [
          {
            key: "overtimeMinutes",
            label: "Overtime",
            format: "overtime-duration",
          },
        ],
        rows: [
          { id: "shortfall", overtimeMinutes: -30 },
          { id: "complete", overtimeMinutes: 0 },
          { id: "below-threshold", overtimeMinutes: 29 },
          { id: "threshold", overtimeMinutes: 30 },
          { id: "above-threshold", overtimeMinutes: 31 },
          { id: "long-overtime", overtimeMinutes: 90 },
          { id: "unknown", overtimeMinutes: null },
          { id: "missing" },
        ],
      }),
    );
    expect(markup.match(/<td>.*?<\/td>/g)).toEqual([
      '<td><span class="overtime-duration overtime-excluded">-0h 30m</span></td>',
      '<td><span class="overtime-duration overtime-excluded">0h 0m</span></td>',
      '<td><span class="overtime-duration overtime-excluded">0h 29m</span></td>',
      '<td><span class="overtime-duration overtime-counted">0h 30m</span></td>',
      '<td><span class="overtime-duration overtime-counted">0h 31m</span></td>',
      '<td><span class="overtime-duration overtime-counted">1h 30m</span></td>',
      "<td>—</td>",
      "<td>—</td>",
    ]);
  });

  it("keeps unrelated nullable duration columns neutral", () => {
    const markup = renderToStaticMarkup(
      h(Table, {
        columns: [
          { key: "minutes", label: "Duration", format: "nullable-duration" },
        ],
        rows: [
          { id: "shortfall", minutes: -30 },
          { id: "complete", minutes: 0 },
          { id: "unknown", minutes: null },
        ],
      }),
    );
    expect(markup.match(/<td>.*?<\/td>/g)).toEqual([
      "<td>-0h 30m</td>",
      "<td>0h 0m</td>",
      "<td>—</td>",
    ]);
  });

  it("formats signed durations in metrics with one leading minus", () => {
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

function renderToStaticMarkup(children: React.ReactNode) {
  const props = {
    locale: "en",
    timeZone: "Asia/Dhaka",
    messages: testMessages,
    children,
  };
  return renderMarkup(h(NextIntlClientProvider, props));
}
