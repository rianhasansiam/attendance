import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  PageBreak,
  PageNumber,
  PageOrientation,
  Paragraph,
  Packer,
  Tab,
  TabStopType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  convertMillimetersToTwip,
  type IParagraphOptions,
} from "docx";
import { formatMoney } from "@/i18n/format-money";
import type { SalaryAttendanceDTO, SalaryCalculationDTO } from "./contracts";

export const SALARY_DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const brand = {
  name: "XianHao Yida Technology Co. Ltd.",
  red: "C30708",
  ink: "000000",
  muted: "66666D",
  line: "D9D9D9",
  shade: "F7F7F8",
};
const pageWidth = convertMillimetersToTwip(210);
const margin = convertMillimetersToTwip(19);
const contentWidth = pageWidth - margin * 2;

type StatementOptions = {
  /** null deliberately omits the existing local company mark. */
  logo?: Buffer | null;
};

function plain(value: string) {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function text(value: string, options: IParagraphOptions = {}, bold?: boolean) {
  return new Paragraph({
    widowControl: true,
    spacing: { before: 0, after: 90 },
    ...options,
    children: [new TextRun({ text: plain(value), bold })],
  });
}

function duration(minutes: number) {
  const absolute = Math.abs(minutes);
  return `${minutes < 0 ? "−" : ""}${Math.floor(absolute / 60)}h ${absolute % 60}m`;
}

function date(value: string) {
  // Report dates are already office-local calendar dates, not timestamps.
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00.000Z`));
}

function timestamp(value: string | null, timezone: string, reportDate: string) {
  if (!value) return "—";
  const instant = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  }).formatToParts(instant);
  const part = (name: string) =>
    parts.find((entry) => entry.type === name)?.value;
  const localDate = `${part("year")}-${part("month")}-${part("day")}`;
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  }).format(instant);
  // Overnight sessions retain their next-day date instead of looking reversed.
  return localDate === reportDate ? time : `${time}\n${date(localDate)}`;
}

function status(row: SalaryAttendanceDTO) {
  if (row.incomplete) return "Incomplete";
  const labels: Record<string, string> = {
    PRESENT: "Present",
    LATE: "Late",
    ABSENT: "Absent",
    HALF_DAY: "Half day",
    LEAVE: "Leave",
    HOLIDAY: "Holiday",
    WEEKEND: "Weekend",
  };
  const label = labels[row.status] ?? row.status;
  return row.isExcusedLate ? `${label}\nLate arrival excused` : label;
}

function cell(
  value: string,
  width: number,
  {
    right = false,
    bold = false,
    fill,
    size = 20,
    color = brand.ink,
    padding = 95,
  }: {
    right?: boolean;
    bold?: boolean;
    fill?: string;
    size?: number;
    color?: string;
    padding?: number;
  } = {},
) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    shading: fill ? { fill } : undefined,
    margins: { top: padding, bottom: padding, left: 120, right: 120 },
    children: [
      new Paragraph({
        alignment: right ? AlignmentType.RIGHT : AlignmentType.LEFT,
        spacing: { before: 0, after: 0, line: 250 },
        children: value.split("\n").map(
          (line, index) =>
            new TextRun({
              text: plain(line),
              bold,
              size,
              color,
              break: index ? 1 : undefined,
            }),
        ),
      }),
    ],
  });
}

function table(rows: TableRow[], widths: number[]) {
  const border = { style: BorderStyle.SINGLE, size: 4, color: brand.line };
  return new Table({
    width: { size: contentWidth, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    borders: {
      top: border,
      bottom: border,
      left: border,
      right: border,
      insideHorizontal: border,
      insideVertical: border,
    },
    rows,
  });
}

function heading(value: string) {
  return text(value, {
    heading: HeadingLevel.HEADING_1,
    keepNext: true,
    spacing: { before: 220, after: 120 },
  });
}

function metadata(pairs: Array<[string, string | null | undefined]>) {
  return new Paragraph({
    keepNext: true,
    widowControl: true,
    spacing: { after: 80 },
    children: pairs.flatMap(([label, value], index) => [
      ...(index ? [new TextRun({ text: "   ·   " })] : []),
      new TextRun({ text: `${label} `, bold: true }),
      new TextRun({ text: plain(value || "—") }),
    ]),
  });
}

function signatureLine(
  employee: string,
  preparer: string,
  options: { before?: number; bold?: boolean; last?: boolean } = {},
) {
  // Tab stops keep the editable form open and usable without a boxed grid.
  return new Paragraph({
    keepNext: !options.last,
    widowControl: true,
    tabStops: [
      { type: TabStopType.LEFT, position: Math.round(contentWidth * 0.54) },
    ],
    spacing: { before: options.before ?? 0, after: 90 },
    children: [
      new TextRun({ text: employee, bold: options.bold, size: 20 }),
      new TextRun({ children: [new Tab()] }),
      new TextRun({ text: preparer, bold: options.bold, size: 20 }),
    ],
  });
}

async function localLogo(options: StatementOptions) {
  if (options.logo !== undefined) return options.logo;
  // A fixed application asset avoids external image requests and arbitrary paths.
  try {
    return await readFile(path.join(process.cwd(), "public/company_logo.jpeg"));
  } catch {
    return null;
  }
}

export function salaryStatementFilename(
  employeeCode: string,
  period: string,
  from?: string,
  to?: string,
) {
  const code =
    employeeCode
      .normalize("NFKC")
      .replace(/[^A-Za-z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "employee";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))
    throw new Error("Invalid payroll month.");
  let range = "";
  if (from !== undefined || to !== undefined) {
    const validDate = (value: string | undefined): value is string => {
      if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const parsed = new Date(`${value}T12:00:00.000Z`);
      return (
        !Number.isNaN(parsed.valueOf()) &&
        parsed.toISOString().slice(0, 10) === value
      );
    };
    if (!validDate(from) || !validDate(to) || from > to)
      throw new Error("Invalid salary date range.");
    if (from !== `${period}-01` || to !== monthEnd(period))
      range = `${from}-to-${to}`;
  }
  return `salary-statement-${code}-${range || period}.docx`;
}

function monthEnd(period: string) {
  const end = new Date(`${period}-01T12:00:00.000Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  return end.toISOString().slice(0, 10);
}

/** Uses the same server-owned amounts and attendance projection as the preview. */
export async function salaryStatementDocx(
  data: SalaryCalculationDTO,
  options: StatementOptions = {},
): Promise<Buffer> {
  if (data.attendance.some((row) => row.date < data.from || row.date > data.to))
    throw new Error("Salary attendance falls outside the selected date range.");
  const logo = await localLogo(options);
  const periodLabel = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${data.period}-01T12:00:00Z`));
  const generated = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: data.timezone,
  }).format(new Date(data.generatedAt));
  const rangeLabel = `${date(data.from)} to ${date(data.to)} inclusive`;
  const weekendNames =
    data.configuredWeekendDays
      .map(
        (day) =>
          [
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
          ][day],
      )
      .join(", ") || "None";
  const money = (value: string) => formatMoney(value, data.currency, "en");
  const salaryWidth = [Math.round(contentWidth * 0.64), 0];
  salaryWidth[1] = contentWidth - salaryWidth[0];
  const salaryRow = (label: string, value: string, total = false) =>
    new TableRow({
      cantSplit: true,
      children: [
        cell(label, salaryWidth[0], {
          bold: total,
          fill: total ? "FFF1F1" : undefined,
        }),
        cell(value, salaryWidth[1], {
          right: true,
          bold: total,
          fill: total ? "FFF1F1" : undefined,
          color: total ? brand.red : brand.ink,
          size: total ? 28 : 22,
        }),
      ],
    });
  const rows = [...data.attendance].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.checkInAt ?? "").localeCompare(b.checkInAt ?? "") ||
      a.id.localeCompare(b.id),
  );
  const widths = [1550, 1450, 1450, 1350, 1350, contentWidth - 7150];
  const attendanceHeaders = [
    "Date",
    "Check-in",
    "Check-out",
    "Worked",
    "Payable overtime",
    "Status",
  ];
  const attendanceRows = [
    new TableRow({
      tableHeader: true,
      cantSplit: true,
      children: attendanceHeaders.map((value, index) =>
        cell(value, widths[index], {
          bold: true,
          fill: brand.shade,
          size: 18,
          padding: 70,
          right: index === 3 || index === 4,
        }),
      ),
    }),
    ...rows.map(
      (row, index) =>
        new TableRow({
          cantSplit: true,
          children: [
            date(row.date),
            timestamp(row.checkInAt, row.timezone, row.date),
            timestamp(row.checkOutAt, row.timezone, row.date),
            duration(row.workedMinutes),
            duration(row.payableOvertimeMinutes),
            status(row),
          ].map((value, column) =>
            cell(value, widths[column], {
              size: 18,
              padding: 70,
              right: column === 3 || column === 4,
              fill: index % 2 ? brand.shade : undefined,
            }),
          ),
        }),
    ),
    new TableRow({
      cantSplit: true,
      children: [
        "Total",
        "",
        "",
        duration(data.summary.workedMinutes),
        duration(data.payableOvertimeMinutes),
        `${rows.length} records`,
      ].map((value, column) =>
        cell(value, widths[column], {
          size: 18,
          bold: true,
          padding: 70,
          fill: "FFF1F1",
          right: column === 3 || column === 4,
        }),
      ),
    }),
  ];
  const children: Array<Paragraph | Table> = [];
  if (logo)
    children.push(
      new Paragraph({
        keepNext: true,
        spacing: { after: 80 },
        children: [
          new ImageRun({
            data: logo,
            type: "jpg",
            transformation: { width: 130, height: 25 },
            altText: {
              title: "XHYD",
              description: "XHYD company logo",
              name: "XHYD logo",
            },
          }),
        ],
      }),
    );
  children.push(
    text(brand.name, { keepNext: true, spacing: { after: 120 } }, true),
    text("Employee Salary Statement", {
      heading: HeadingLevel.TITLE,
      keepNext: true,
      spacing: { after: 130 },
    }),
    metadata([["Payroll month", periodLabel]]),
    metadata([["Attendance range", rangeLabel]]),
    new Paragraph({
      keepNext: true,
      spacing: { after: 100 },
      children: [
        new TextRun({
          text: `Generated ${generated} (${data.timezone})`,
          size: 18,
          color: brand.muted,
        }),
      ],
    }),
    text(
      data.ongoing
        ? "Provisional calculation for an ongoing month. Overtime reflects attendance recorded so far."
        : "Range base salary and payable overtime for the selected inclusive dates.",
      {
        keepNext: true,
        spacing: { after: 100 },
      },
    ),
    heading("Employee details"),
    metadata([["Employee name", data.employee.name]]),
    metadata([
      ["Employee ID", data.employee.employeeCode],
      ["Office", data.employee.officeName],
    ]),
    metadata([
      ["Department", data.employee.department],
      ["Designation", data.employee.designation],
    ]),
    heading("Salary summary"),
    text(
      `${data.calendarDays} inclusive calendar days − ${data.weekendDays} office weekend days = ${data.payableDays} payable days`,
      {
        keepNext: true,
        spacing: { after: 100 },
      },
    ),
    table(
      [
        new TableRow({
          tableHeader: true,
          cantSplit: true,
          children: [
            cell("Calculation component", salaryWidth[0], {
              bold: true,
              fill: brand.shade,
            }),
            cell("Amount or quantity", salaryWidth[1], {
              right: true,
              bold: true,
              fill: brand.shade,
            }),
          ],
        }),
        salaryRow("Monthly reference salary", money(data.monthlyBaseSalary)),
        salaryRow("Fixed monthly divisor", String(data.salaryDivisor)),
        salaryRow("Payable days", String(data.payableDays)),
        salaryRow("Range base salary", money(data.baseSalary)),
        salaryRow(
          "Payable overtime duration",
          duration(data.payableOvertimeMinutes),
        ),
        salaryRow("Overtime hourly rate", money(data.overtimeHourlyRate)),
        salaryRow("Overtime earnings", money(data.overtimeEarnings)),
        salaryRow("Total calculated salary", money(data.totalSalary), true),
      ],
      salaryWidth,
    ),
    text(
      `Range base: ${money(data.monthlyBaseSalary)} ÷ ${data.salaryDivisor} × ${data.payableDays} payable days = ${money(data.baseSalary)}`,
      {
        spacing: { before: 140, after: 90 },
      },
    ),
    text(
      `Office weekends: ${weekendNames}. Excluded from base pay. Payable overtime includes all selected attendance records.`,
      { spacing: { after: 90 } },
    ),
    text(
      `Attendance summary: ${data.summary.records} records · Worked ${duration(data.summary.workedMinutes)} · Payable overtime ${duration(data.payableOvertimeMinutes)}`,
      {
        spacing: { after: 80 },
      },
    ),
  );
  if (data.payableOvertimeMinutes < 0)
    children.push(
      text(
        "The payable overtime balance includes the attendance system's existing signed time adjustments.",
        { spacing: { after: 100 } },
      ),
    );
  children.push(
    heading("Acknowledgment"),
    text(
      "Signing acknowledges receipt and review of this statement only. It does not record payment or approval.",
      { keepNext: true, spacing: { after: 100 } },
    ),
    signatureLine("Employee acknowledgment", "Prepared by", { bold: true }),
    signatureLine(
      "Signature ________________________",
      "Signature ________________________",
      { before: 300 },
    ),
    signatureLine(
      "Date _____________________________",
      "Name _____________________________",
    ),
    signatureLine("", "Date _____________________________", { last: true }),
    new Paragraph({ children: [new PageBreak()], spacing: { after: 0 } }),
    text("Attendance Details", {
      heading: HeadingLevel.HEADING_1,
      keepNext: true,
      spacing: { before: 0, after: 140 },
    }),
    text(
      `${rangeLabel} · ${data.employee.employeeCode}`,
      { keepNext: true },
      true,
    ),
    text(
      "Times use each attendance record's office timezone. Overnight timestamps include their local calendar date. Missing timestamps are shown as —.",
      {
        keepNext: true,
        spacing: { after: 160 },
      },
    ),
    table(attendanceRows, widths),
  );
  if (!rows.length)
    children.push(
      text("No attendance records are available for the selected date range.", {
        spacing: { before: 140, after: 0 },
      }),
    );
  const document = new Document({
    creator: brand.name,
    title: "Employee Salary Statement",
    subject: `${data.employee.employeeCode} ${data.period} ${data.from} to ${data.to}`,
    description:
      "Employee salary calculation with supporting attendance details",
    styles: {
      default: {
        document: {
          run: { font: "Arial", size: 22, color: brand.ink },
          paragraph: { spacing: { line: 264 } },
        },
        title: {
          run: { font: "Arial", size: 42, bold: true, color: brand.ink },
          paragraph: { spacing: { after: 140 } },
        },
        heading1: {
          run: { font: "Arial", size: 25, bold: true, color: brand.ink },
          paragraph: { keepNext: true },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: pageWidth,
              height: convertMillimetersToTwip(297),
              orientation: PageOrientation.PORTRAIT,
            },
            margin: {
              top: margin,
              bottom: margin,
              left: margin,
              right: margin,
              header: convertMillimetersToTwip(8),
              footer: convertMillimetersToTwip(9),
            },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                tabStops: [{ type: TabStopType.RIGHT, position: contentWidth }],
                children: [
                  new TextRun({
                    text: plain(
                      `${data.employee.employeeCode} · ${data.period}`,
                    ),
                    size: 16,
                    color: brand.muted,
                  }),
                  new TextRun({ children: [new Tab()] }),
                  new TextRun({
                    children: [
                      "Page ",
                      PageNumber.CURRENT,
                      " of ",
                      PageNumber.TOTAL_PAGES,
                    ],
                    size: 16,
                    color: brand.muted,
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(document);
}
