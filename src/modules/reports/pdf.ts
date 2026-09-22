import "server-only";

import path from "node:path";
import PDFDocument from "pdfkit";

export type PdfReport = {
  title: string;
  subtitle: string[];
  summary: Array<{ label: string; value: string }>;
  columns: Array<{ label: string; width: number; align?: "left" | "right" }>;
  rows: string[][];
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
  summary: "#EEF6F0",
};

/**
 * Wrap before painting so all columns share row boundaries. Grapheme segmentation
 * keeps Bengali vowel signs and conjuncts together when a long word must wrap.
 */
function wrapText(doc: PDFKit.PDFDocument, value: string, width: number) {
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
      if (doc.widthOfString(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line) {
        lines.push(line);
        line = "";
      }
      if (doc.widthOfString(word) <= width) {
        line = word;
        continue;
      }
      for (const { segment } of graphemes.segment(word)) {
        if (line && doc.widthOfString(line + segment) > width) {
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

  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margin,
    font: regularFont,
    bufferPages: true,
    info: {
      Title: report.title,
      Author: "BangBuy Attendance System",
      Subject: report.subtitle.join(" | "),
    },
  });
  doc.registerFont("Regular", regularFont);
  doc.registerFont("Bold", boldFont);
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
    const left = align === "right" ? x + width - doc.widthOfString(text) : x;
    // Each line was measured above; disabling automatic flow avoids accidental
    // page creation when painting a cell or footer near the bottom margin.
    doc.text(text, left, top, { lineBreak: false });
  }

  function pageHeading(continued: boolean) {
    doc.rect(margin, margin, 3, 24).fill(colors.green);
    doc.font("Bold").fontSize(9).fillColor(colors.green);
    paintLine(
      "BANGBUY ATTENDANCE SYSTEM",
      margin + 12,
      margin - 1,
      contentWidth - 12,
    );
    doc.fontSize(continued ? 16 : 23).fillColor(colors.dark);
    y = margin + 17;
    const headingLines = wrapText(doc, report.title, contentWidth - 12);
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
  doc.font("Regular").fontSize(9).fillColor(colors.muted);
  for (const subtitle of report.subtitle) {
    const lines = wrapText(doc, subtitle, contentWidth);
    for (const line of lines) {
      if (y + lineHeight() > contentBottom) {
        newPage();
        doc.font("Regular").fontSize(9).fillColor(colors.muted);
      }
      paintLine(line, margin, y, contentWidth);
      y += lineHeight();
    }
  }
  y += 14;

  const cardsPerRow = Math.min(4, report.summary.length);
  const cardGap = 10;
  const cardWidth =
    (contentWidth - cardGap * (cardsPerRow - 1)) / Math.max(1, cardsPerRow);
  for (let start = 0; start < report.summary.length; start += cardsPerRow) {
    const cards = report.summary
      .slice(start, start + cardsPerRow)
      .map((card) => {
        doc.font("Regular").fontSize(8.5);
        const labels = wrapText(doc, card.label, cardWidth - 24);
        const labelHeight = lineHeight();
        doc.font("Bold").fontSize(13);
        const values = wrapText(doc, card.value, cardWidth - 24);
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
      doc.font("Regular").fontSize(8.5).fillColor(colors.muted);
      for (const line of card.labels) {
        paintLine(line, x + 12, top, cardWidth - 24);
        top += card.labelHeight;
      }
      doc.font("Bold").fontSize(13).fillColor(colors.green);
      for (const line of card.values) {
        paintLine(line, x + 12, top, cardWidth - 24);
        top += card.valueHeight;
      }
    });
    y += height + cardGap;
  }
  y += 7;

  doc.font("Bold").fontSize(bodySize);
  const headings = report.columns.map((column, index) =>
    wrapText(doc, column.label, widths[index] - cellPadding * 2),
  );
  const headingLineHeight = lineHeight();
  const headingHeight =
    Math.max(...headings.map((lines) => lines.length)) * headingLineHeight +
    cellPadding * 2;

  function tableHeading() {
    doc.rect(margin, y, contentWidth, headingHeight).fill(colors.green);
    doc.font("Bold").fontSize(bodySize).fillColor("#FFFFFF");
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
    doc.font("Regular").fontSize(bodySize).fillColor(colors.dark);
  }

  function tablePage() {
    newPage();
    tableHeading();
  }

  doc.font("Regular").fontSize(bodySize);
  const bodyLineHeight = lineHeight();
  if (y + headingHeight + bodyLineHeight + cellPadding * 2 > contentBottom)
    newPage();
  tableHeading();

  report.rows.forEach((row, rowIndex) => {
    const cells = report.columns.map((_, index) =>
      wrapText(doc, row[index] ?? "", widths[index] - cellPadding * 2),
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
      if (availableLines < 1) {
        tablePage();
        availableLines = Math.floor(
          (contentBottom - y - cellPadding * 2) / bodyLineHeight,
        );
      }
      const count = Math.min(lines - offset, availableLines);
      const height = count * bodyLineHeight + cellPadding * 2;
      doc
        .rect(margin, y, contentWidth, height)
        .fill(rowIndex % 2 ? colors.stripe : "#FFFFFF");
      doc.font("Regular").fontSize(bodySize).fillColor(colors.dark);
      let x = margin;
      cells.forEach((cell, index) => {
        cell
          .slice(offset, offset + count)
          .forEach((line, lineIndex) =>
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
    doc.font("Regular").fontSize(10).fillColor(colors.muted);
    paintLine(
      "No records match the selected filters.",
      margin + cellPadding,
      y + 16,
      contentWidth - cellPadding * 2,
    );
    y += 45;
  }

  if (report.footerNote) {
    y += 12;
    doc.font("Regular").fontSize(8).fillColor(colors.muted);
    const notes = wrapText(doc, report.footerNote, contentWidth);
    for (const note of notes) {
      if (y + lineHeight() > contentBottom) {
        newPage();
        doc.font("Regular").fontSize(8).fillColor(colors.muted);
      }
      paintLine(note, margin, y, contentWidth);
      y += lineHeight();
    }
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
    doc.font("Regular").fontSize(8).fillColor(colors.muted);
    paintLine(
      "BangBuy Attendance System",
      margin,
      pageHeight - 28,
      contentWidth / 2,
    );
    paintLine(
      `${report.rows.length} records  |  Page ${page + 1} of ${pageCount}`,
      margin,
      pageHeight - 28,
      contentWidth,
      "right",
    );
  }

  doc.end();
  return result;
}
