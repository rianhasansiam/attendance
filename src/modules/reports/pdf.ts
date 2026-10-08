import "server-only";

import type { Locale } from "@/i18n/config";
import { createReportTranslator } from "./translations";
import path from "node:path";
import PDFDocument from "pdfkit";

export type PdfReport = {
  locale?: Locale;
  title: string;
  subtitle: string[];
  summary: Array<{ label: string; value: string }>;
  columns: Array<{ label: string; width: number; align?: "left" | "right" }>;
  rows: string[][];
  cellTextColors?: Array<Array<string | undefined>>;
  dateGroupColumn?: number;
  footerNote?: string;
};

const regularFont = path.join(
  process.cwd(),
  "src/assets/fonts/HindSiliguri-Regular.ttf",
);
const boldFont = path.join(
  process.cwd(),
  "src/assets/fonts/HindSiliguri-Bold.ttf",
);
const margin = 36;
const cellPadding = 7;
const bodySize = 8.5;
const colors = {
  green: "#176B4A",
  dark: "#16372C",
  muted: "#5F7068",
  line: "#DDE7E1",
  stripe: "#F5F9F6",
  dateGroups: ["#DCEBE1", "#DCE7F8"],
  summary: "#EEF6F0",
};

/**
 * Wrap before painting so all columns share row boundaries. Grapheme segmentation
 * keeps Bengali vowel signs and conjuncts together when a long word must wrap.
 */
function wrapText(
  doc: PDFKit.PDFDocument,
  value: string,
  width: number,
  measure = (text: string) => doc.widthOfString(text),
) {
  const lines: string[] = [];
  const graphemes = new Intl.Segmenter("bn", { granularity: "grapheme" });
  const text = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.trim().split(/\s+/u)) {
      if (!word) continue;
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line) {
        lines.push(line);
        line = "";
      }
      if (measure(word) <= width) {
        line = word;
        continue;
      }
      for (const { segment } of graphemes.segment(word)) {
        if (line && measure(line + segment) > width) {
          lines.push(line);
          line = "";
        }
        line += segment;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Render every supplied record into a portable, paginated landscape A4 PDF. */
export async function createReportPdf(report: PdfReport): Promise<Uint8Array> {
  if (
    report.columns.length === 0 ||
    report.columns.some(({ width }) => !Number.isFinite(width) || width <= 0)
  ) {
    throw new Error("PDF columns must have positive width weights.");
  }

  const t = createReportTranslator(report.locale || "en");
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margin,
    font: regularFont,
    bufferPages: true,
    info: {
      Title: report.title,
      Author: t("pdf.brand"),
      Subject: report.subtitle.join(" | "),
    },
  });
  doc.registerFont("Regular", regularFont);
  doc.registerFont("Bold", boldFont);
  doc.registerFont(
    "CJK",
    path.join(process.cwd(), "src/assets/fonts/NotoSansCJKsc-Regular.otf"),
  );
  let activeFont = "Regular";
  function font(name: string) {
    activeFont = name;
    return doc.font(name);
  }
  const cjk = /([\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]+)/u;
  function runs(text: string) {
    return text.split(cjk).filter(Boolean);
  }
  function measure(text: string) {
    let width = 0;
    for (const run of runs(text)) {
      doc.font(cjk.test(run) ? "CJK" : activeFont);
      width += doc.widthOfString(run);
    }
    doc.font(activeFont);
    return width;
  }
  function wrap(value: string, width: number) {
    return wrapText(doc, value, width, measure);
  }
  const chunks: Buffer[] = [];
  const result = new Promise<Uint8Array>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    doc.on("error", reject);
  });

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const contentWidth = pageWidth - margin * 2;
  const contentBottom = pageHeight - 50;
  const weight = report.columns.reduce((sum, column) => sum + column.width, 0);
  const widths = report.columns.map(
    (column) => (column.width / weight) * contentWidth,
  );
  if (widths.some((width) => width <= cellPadding * 2 + 8)) {
    throw new Error("PDF columns are too narrow to render readable text.");
  }
  let y = margin;

  function lineHeight() {
    return doc.currentLineHeight(true) + 0.8;
  }

  function paintLine(
    text: string,
    x: number,
    top: number,
    width: number,
    align: "left" | "right" = "left",
  ) {
    let left = align === "right" ? x + width - measure(text) : x;
    // Each line was measured above; disabling automatic flow avoids accidental
    // page creation when painting a cell or footer near the bottom margin.
    for (const run of runs(text)) {
      doc.font(cjk.test(run) ? "CJK" : activeFont);
      doc.text(run, left, top, { lineBreak: false });
      left += doc.widthOfString(run);
    }
    doc.font(activeFont);
  }

  function pageHeading(continued: boolean) {
    doc.rect(margin, margin, 3, 24).fill(colors.green);
    font("Bold").fontSize(9).fillColor(colors.green);
    paintLine(
      t("pdf.brandHeading"),
      margin + 12,
      margin - 1,
      contentWidth - 12,
    );
    doc.fontSize(continued ? 16 : 23).fillColor(colors.dark);
    y = margin + 17;
    const headingLines = wrap(report.title, contentWidth - 12);
    for (const line of headingLines) {
      paintLine(line, margin + 12, y, contentWidth - 12);
      y += lineHeight();
    }
    y += continued ? 13 : 8;
  }

  function newPage() {
    doc.addPage();
    pageHeading(true);
  }

  pageHeading(false);
  font("Regular").fontSize(9).fillColor(colors.muted);
  for (const subtitle of report.subtitle) {
    const lines = wrap(subtitle, contentWidth);
    for (const line of lines) {
      if (y + lineHeight() > contentBottom) {
        newPage();
        font("Regular").fontSize(9).fillColor(colors.muted);
      }
      paintLine(line, margin, y, contentWidth);
      y += lineHeight();
    }
  }
  y += 14;

  const cardsPerRow = Math.min(5, report.summary.length);
  const cardGap = 10;
  const cardWidth =
    (contentWidth - cardGap * (cardsPerRow - 1)) / Math.max(1, cardsPerRow);
  for (let start = 0; start < report.summary.length; start += cardsPerRow) {
    const cards = report.summary
      .slice(start, start + cardsPerRow)
      .map((card) => {
        font("Regular").fontSize(8.5);
        const labels = wrap(card.label, cardWidth - 24);
        const labelHeight = lineHeight();
        font("Bold").fontSize(13);
        const values = wrap(card.value, cardWidth - 24);
        const valueHeight = lineHeight();
        return { labels, labelHeight, values, valueHeight };
      });
    const height = Math.max(
      ...cards.map(
        (card) =>
          20 +
          card.labels.length * card.labelHeight +
          card.values.length * card.valueHeight,
      ),
    );
    if (y + height > contentBottom) newPage();
    cards.forEach((card, index) => {
      const x = margin + index * (cardWidth + cardGap);
      doc.roundedRect(x, y, cardWidth, height, 5).fill(colors.summary);
      let top = y + 8;
      font("Regular").fontSize(8.5).fillColor(colors.muted);
      for (const line of card.labels) {
        paintLine(line, x + 12, top, cardWidth - 24);
        top += card.labelHeight;
      }
      font("Bold").fontSize(13).fillColor(colors.green);
      for (const line of card.values) {
        paintLine(line, x + 12, top, cardWidth - 24);
        top += card.valueHeight;
      }
    });
    y += height + cardGap;
  }
  y += 7;

  if (report.footerNote) {
    font("Regular").fontSize(8).fillColor(colors.muted);
    const notes = wrap(report.footerNote, contentWidth);
    for (const note of notes) {
      if (y + lineHeight() > contentBottom) {
        newPage();
        font("Regular").fontSize(8).fillColor(colors.muted);
      }
      paintLine(note, margin, y, contentWidth);
      y += lineHeight();
    }
    y += 12;
  }

  font("Bold").fontSize(bodySize);
  const headings = report.columns.map((column, index) =>
    wrap(column.label, widths[index] - cellPadding * 2),
  );
  const headingLineHeight = lineHeight();
  const headingHeight =
    Math.max(...headings.map((lines) => lines.length)) * headingLineHeight +
    cellPadding * 2;

  function tableHeading() {
    doc.rect(margin, y, contentWidth, headingHeight).fill(colors.green);
    font("Bold").fontSize(bodySize).fillColor("#FFFFFF");
    let x = margin;
    headings.forEach((lines, index) => {
      lines.forEach((line, lineIndex) =>
        paintLine(
          line,
          x + cellPadding,
          y + cellPadding + lineIndex * headingLineHeight,
          widths[index] - cellPadding * 2,
          report.columns[index].align,
        ),
      );
      x += widths[index];
    });
    y += headingHeight;
    font("Regular").fontSize(bodySize).fillColor(colors.dark);
  }

  function tablePage() {
    newPage();
    tableHeading();
  }

  font("Regular").fontSize(bodySize);
  const bodyLineHeight = lineHeight();
  if (y + headingHeight + bodyLineHeight + cellPadding * 2 > contentBottom)
    newPage();
  tableHeading();

  const dateGroups = new Map<string, string>();
  report.rows.forEach((row, rowIndex) => {
    let background = rowIndex % 2 ? colors.stripe : "#FFFFFF";
    if (report.dateGroupColumn !== undefined) {
      const groupDate = row[report.dateGroupColumn] ?? "";
      let groupColor = dateGroups.get(groupDate);
      if (groupColor === undefined) {
        groupColor =
          colors.dateGroups[dateGroups.size % colors.dateGroups.length];
        dateGroups.set(groupDate, groupColor);
      }
      background = groupColor;
    }
    const cells = report.columns.map((_, index) =>
      wrap(row[index] ?? "", widths[index] - cellPadding * 2),
    );
    const lines = Math.max(...cells.map((cell) => cell.length));
    const rowHeight = lines * bodyLineHeight + cellPadding * 2;
    // Keep ordinary rows together, but allow an exceptionally long reason or
    // destination to continue across pages without clipping or dropping text.
    const freshPageCapacity =
      contentBottom - (margin + 17 + (16 * 1.617 + 0.8) + 13 + headingHeight);
    if (rowHeight <= freshPageCapacity && y + rowHeight > contentBottom)
      tablePage();
    let offset = 0;
    while (offset < lines) {
      let availableLines = Math.floor(
        (contentBottom - y - cellPadding * 2) / bodyLineHeight,
      );
      const continuation =
        offset > 0 && cells[0].length <= offset
          ? [...cells[0].slice(0, 2), t("pdf.continued")]
          : null;
      const minimumLines = Math.max(
        Math.min(3, lines - offset),
        continuation?.length ?? 0,
      );
      if (availableLines < minimumLines) {
        tablePage();
        availableLines = Math.floor(
          (contentBottom - y - cellPadding * 2) / bodyLineHeight,
        );
      }
      let count = Math.min(lines - offset, availableLines);
      const remaining = lines - offset - count;
      if (remaining > 0 && remaining < 3 && count > 3) count -= 3 - remaining;
      const height =
        Math.max(count, continuation?.length ?? 0) * bodyLineHeight +
        cellPadding * 2;
      doc.rect(margin, y, contentWidth, height).fill(background);
      font("Regular").fontSize(bodySize).fillColor(colors.dark);
      let x = margin;
      cells.forEach((cell, index) => {
        doc.fillColor(
          report.cellTextColors?.[rowIndex]?.[index] ?? colors.dark,
        );
        const visibleLines =
          index === 0 && continuation
            ? continuation
            : cell.slice(offset, offset + count);
        visibleLines.forEach((line, lineIndex) =>
          paintLine(
            line,
            x + cellPadding,
            y + cellPadding + lineIndex * bodyLineHeight,
            widths[index] - cellPadding * 2,
            report.columns[index].align,
          ),
        );
        x += widths[index];
      });
      y += height;
      doc
        .moveTo(margin, y)
        .lineTo(pageWidth - margin, y)
        .strokeColor(colors.line)
        .lineWidth(0.5)
        .stroke();
      offset += count;
      if (offset < lines) tablePage();
    }
  });

  if (report.rows.length === 0) {
    font("Regular").fontSize(10).fillColor(colors.muted);
    paintLine(
      t("pdf.empty"),
      margin + cellPadding,
      y + 16,
      contentWidth - cellPadding * 2,
    );
    y += 45;
  }

  const { count: pageCount } = doc.bufferedPageRange();
  for (let page = 0; page < pageCount; page++) {
    doc.switchToPage(page);
    doc
      .moveTo(margin, pageHeight - 34)
      .lineTo(pageWidth - margin, pageHeight - 34)
      .strokeColor(colors.line)
      .lineWidth(0.5)
      .stroke();
    font("Regular").fontSize(8).fillColor(colors.muted);
    paintLine(t("pdf.brand"), margin, pageHeight - 28, contentWidth / 2);
    paintLine(
      t("pdf.pageSummary", {
        count: report.rows.length,
        page: page + 1,
        pages: pageCount,
      }),
      margin,
      pageHeight - 28,
      contentWidth,
      "right",
    );
  }

  doc.end();
  return result;
}
