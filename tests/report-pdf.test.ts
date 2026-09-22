import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
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
      pages.push(
        items
          .map((item) => item.str)
          .join(" ")
          .replace(/\s+/g, " "),
      );
    }
    return { pages, metadata: await document.getMetadata() };
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
    expect(pages[0]).toContain("1 records | Page 1 of 1");
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
});
