import { describe, expect, it } from "vitest";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createReportPdf, type PdfReport } from "@/modules/reports/pdf";

const report: PdfReport = {
  title: "Attendance report",
  subtitle: ["01 Sep 2026 to 30 Sep 2026", "Employee: Test Employee"],
  summary: [
    { label: "Matching records", value: "1" },
    { label: "Total overtime", value: "0h 40m" },
  ],
  columns: [
    { label: "Date", width: 1 },
    { label: "Employee", width: 2 },
    { label: "Reason", width: 3 },
    { label: "Overtime", width: 1, align: "right" },
  ],
  rows: [["2026-09-22", "Test Employee", "Traffic delay", "0h 40m"]],
  footerNote: "Times are shown in each office's local timezone.",
};

async function readPdf(input: PdfReport) {
  const bytes = await createReportPdf(input);
  expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-");
  const loadingTask = getDocument({
    data: bytes,
    useSystemFonts: false,
  });
  const document = await loadingTask.promise;
  try {
    const pages: string[] = [];
    const positionedText: Array<
      Array<{ text: string; x: number; y: number; width: number }>
    > = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const view = page.getViewport({ scale: 1 });
      expect(view.width).toBeCloseTo(841.89, 1);
      expect(view.height).toBeCloseTo(595.28, 1);
      const content = await page.getTextContent();
      const items = content.items.filter((item) => "str" in item);
      for (const item of items) {
        if (!item.str.trim()) continue;
        expect(item.transform[4]).toBeGreaterThanOrEqual(35);
        expect(item.transform[4] + item.width).toBeLessThanOrEqual(807);
        expect(item.transform[5]).toBeGreaterThan(10);
        expect(item.transform[5]).toBeLessThan(575);
      }
      positionedText.push(
        items.map((item) => ({
          text: item.str,
          x: item.transform[4],
          y: item.transform[5],
          width: item.width,
        })),
      );
      pages.push(
        items
          .map((item) => item.str)
          .join(" ")
          .replace(/\s+/g, " "),
      );
    }
    return { pages, positionedText, metadata: await document.getMetadata() };
  } finally {
    await loadingTask.destroy();
  }
}

describe("PDF report rendering", () => {
  it("renders selected filters, exact minute totals, records and report metadata", async () => {
    const { pages, metadata } = await readPdf(report);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain("Attendance report");
    expect(pages[0]).toContain("01 Sep 2026 to 30 Sep 2026");
    expect(pages[0]).toContain("Employee: Test Employee");
    expect(pages[0]).toContain("Total overtime");
    expect(pages[0].match(/0h 40m/g)).toHaveLength(2);
    expect(pages[0]).toContain("Traffic delay");
    expect(pages[0]).toContain("1 record | Page 1 of 1");
    expect(metadata.info).toMatchObject({ Title: "Attendance report" });
  });

  it("renders every record with repeated table headings and page numbers", async () => {
    const rows = Array.from({ length: 80 }, (_, index) => [
      "2026-09-22",
      `Employee-${String(index).padStart(3, "0")}`,
      "A reason that wraps within its table cell without overlapping.",
      "0h 40m",
    ]);
    const { pages } = await readPdf({ ...report, rows });
    expect(pages.length).toBeGreaterThan(3);
    const text = pages.join(" ");
    for (const row of rows) expect(text.split(row[1])).toHaveLength(2);
    pages.forEach((page, index) => {
      expect(page).toContain("Date Employee Reason Overtime");
      expect(page).toContain(
        `80 records | Page ${index + 1} of ${pages.length}`,
      );
    });
  });

  it("continues oversized rows across pages without clipping their final words", async () => {
    const tokens = Array.from({ length: 500 }, (_, index) => `detail${index}`);
    const { pages } = await readPdf({
      ...report,
      rows: [
        [
          "2026-09-22",
          "মোহাম্মদ রহিম",
          `ঢাকা ${tokens.join(" ")} FINAL-DETAIL`,
          "0h 40m",
        ],
      ],
    });
    expect(pages.length).toBeGreaterThan(2);
    const words = pages.join(" ").split(/\s+/);
    for (const token of tokens)
      expect(words.filter((word) => word === token)).toHaveLength(1);
    expect(pages.at(-1)).toContain("FINAL-DETAIL");
    expect(pages.join(" ")).toContain("ঢাকা");
  });

  it("provides a readable empty report", async () => {
    const { pages } = await readPdf({ ...report, rows: [], summary: [] });
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain("No records match the selected filters.");
    expect(pages[0]).toContain("0 records | Page 1 of 1");
  });

  it("paints overtime cell colors while restoring the default for other cells", async () => {
    const bytes = await createReportPdf({
      ...report,
      rows: [
        ["2026-09-22", "Below minimum", "Excluded", "0h 29m"],
        ["2026-09-23", "At minimum", "Counted", "0h 30m"],
        ["2026-09-24", "Historical", "No schedule", "Unknown"],
      ],
      cellTextColors: [
        [undefined, undefined, undefined, "#B42318"],
        [undefined, undefined, undefined, "#176B4A"],
      ],
    });
    const loadingTask = getDocument({ data: bytes, useSystemFonts: false });
    const document = await loadingTask.promise;
    try {
      const page = await document.getPage(1);
      const operators = await page.getOperatorList();
      let color = "";
      const textColors = new Map<string, string>();
      operators.fnArray.forEach((operation, index) => {
        const args = operators.argsArray[index];
        if (operation === OPS.setFillRGBColor) color = args[0];
        if (operation === OPS.showText) {
          const text = args[0]
            .map((glyph: { unicode?: string } | number) =>
              typeof glyph === "number" ? "" : (glyph.unicode ?? ""),
            )
            .join("");
          textColors.set(text, color);
        }
      });
      expect(textColors.get("0h 29m")).toBe("#b42318");
      expect(textColors.get("0h 30m")).toBe("#176b4a");
      expect(textColors.get("At minimum")).toBe("#16372c");
      expect(textColors.get("Unknown")).toBe("#16372c");
    } finally {
      await loadingTask.destroy();
    }
  });
});

const chineseReport: PdfReport = {
  locale: "zh-CN",
  title: "考勤报表 / Attendance report",
  subtitle: [
    "日期范围：2026/09/01 至 2026/09/30",
    "员工：张明 / Mohammed Rahim / মোহাম্মদ রহিম",
    "办公室：达卡办公室 · Asia/Dhaka",
  ],
  summary: [
    { label: "记录数", value: "2" },
    { label: "总工作时长", value: "16 小时 40 分钟" },
    { label: "总加班时长", value: "-1 小时 20 分钟（-80 分钟）" },
  ],
  columns: [
    { label: "日期 / Date", width: 1 },
    { label: "员工 / Employee", width: 2 },
    { label: "迟到原因 / Reason", width: 3 },
    { label: "加班 / Overtime", width: 1, align: "right" },
  ],
  rows: [
    [
      "2026/09/22",
      "张明 / Zhang Ming",
      "交通拥堵，公交车延误。Traffic delay.",
      "0 小时 40 分钟",
    ],
    [
      "2026/09/23",
      "মোহাম্মদ রহিম",
      "ঢাকা 办公室 / Dhaka office",
      "-2 小时 0 分钟",
    ],
  ],
  footerNote:
    "时间按每条记录的班次时区显示。保留实际迟到分钟数，状态反映已批准的迟到申请。",
};

describe("multilingual PDF fonts and wrapping", () => {
  it("embeds Chinese, English and Bengali glyphs with localized headers and page numbers", async () => {
    const { pages, metadata } = await readPdf(chineseReport);
    expect(pages).toHaveLength(1);
    const text = pages[0].replace(/\s/g, "");
    for (const value of [
      "考勤报表/Attendancereport",
      "张明/ZhangMing",
      "ঢাকা办公室/Dhakaoffice",
      "交通拥堵，公交车延误。Trafficdelay.",
      "-2小时0分钟",
      "XHYD考勤系统",
      "共2条记录|第1页，共1页",
    ])
      expect(text).toContain(value);
    expect(text).not.toMatch(/[\u0000\uFFFD]/);
    // PDF text extraction returns Bengali shaped clusters in visual order. Its
    // decomposed glyph inventory must still preserve every stored character.
    const bengaliGlyphs = (value: string) =>
      Array.from(value.normalize("NFD"))
        .filter((char) => /\p{Script=Bengali}/u.test(char))
        .sort();
    expect(bengaliGlyphs(text)).toEqual(
      bengaliGlyphs("মোহাম্মদ রহিম মোহাম্মদ রহিম ঢাকা"),
    );
    expect(metadata.info).toMatchObject({
      Title: chineseReport.title,
      Author: "XHYD 考勤系统",
    });
  });

  it("wraps long unbroken Chinese rows across pages without losing glyphs or cell boundaries", async () => {
    const marker = "因公共交通延误而迟到需要提交说明";
    const { pages, positionedText } = await readPdf({
      ...chineseReport,
      rows: [
        [
          "2026/09/22",
          "张明 / Zhang Ming",
          marker.repeat(160) + "最后一项说明已完整保留",
          "0 小时 40 分钟",
        ],
      ],
    });
    expect(pages.length).toBeGreaterThan(2);
    const text = pages.join("").replace(/\s/g, "");
    const contentWidth = 841.89 - 72;
    const reasonStart = 36 + (contentWidth * 3) / 7 + 7;
    const reasonEnd = 36 + (contentWidth * 6) / 7 - 7;
    const reasonText = positionedText
      .flat()
      .filter(
        (item) =>
          Math.abs(item.x - reasonStart) < 0.1 &&
          item.x < reasonEnd &&
          item.y > 50 &&
          item.text !== "迟到原因",
      )
      .map((item) => item.text)
      .join("")
      .replace(/[\sA-Za-z/]/g, "");
    expect(reasonText).toBe(marker.repeat(160) + "最后一项说明已完整保留");
    for (const item of positionedText
      .flat()
      .filter(
        (item) =>
          Math.abs(item.x - reasonStart) < 0.1 &&
          item.x < reasonEnd &&
          item.y > 50,
      )) {
      expect(item.x + item.width).toBeLessThanOrEqual(reasonEnd + 0.1);
    }
    expect(pages.at(-1)?.replace(/\s/g, "")).toContain(
      "最后一项说明已完整保留",
    );
    expect(text).toContain("（续）");
    pages.forEach((page, index) => {
      const compact = page.replace(/\s/g, "");
      expect(compact).toContain(
        "日期/Date员工/Employee迟到原因/Reason加班/Overtime",
      );
      expect(compact).toContain(
        `共1条记录|第${index + 1}页，共${pages.length}页`,
      );
    });
  });

  it("preserves Chinese user content in English exports and localizes empty Chinese reports", async () => {
    const english = await readPdf({
      ...report,
      rows: [["2026-09-22", "张明", "交通延误 / ঢাকা", "0h 40m"]],
    });
    expect(english.pages[0].replace(/\s/g, "")).toContain("交通延误/ঢাকা");
    expect(english.pages[0]).toContain("1 record | Page 1 of 1");
    const chinese = await readPdf({ ...chineseReport, rows: [], summary: [] });
    expect(chinese.pages[0].replace(/\s/g, "")).toContain(
      "没有符合所选筛选条件的记录。",
    );
    expect(chinese.pages[0].replace(/\s/g, "")).toContain(
      "共0条记录|第1页，共1页",
    );
  });
});
