import { inflateRawSync } from "node:zlib";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  salaryStatementDocx,
  salaryStatementFilename,
  SALARY_DOCX_MIME,
} from "@/modules/salary/docx";
import { salaryStatementFixture } from "./fixtures/salary-statement";

const word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

// Read the ZIP central directory, including files packed with data descriptors.
// This avoids adding a document reader dependency to the deployed application.
function unzip(bytes: Buffer) {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Missing DOCX ZIP end directory.");
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    expect(bytes.readUInt32LE(cursor)).toBe(0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10);
    const size = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    const name = bytes
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString();
    const start =
      local +
      30 +
      bytes.readUInt16LE(local + 26) +
      bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + size);
    if (method !== 0 && method !== 8)
      throw new Error("Unsupported ZIP compression.");
    entries.set(name, method === 8 ? inflateRawSync(data) : data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function document(
  fixture = salaryStatementFixture(),
  logo: Buffer | null = null,
) {
  const bytes = await salaryStatementDocx(fixture, { logo });
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  const entries = unzip(bytes);
  const xml = entries.get("word/document.xml")?.toString();
  expect(xml).toBeDefined();
  const dom = new JSDOM(xml, { contentType: "application/xml" });
  return { entries, xml: xml!, root: dom.window.document };
}

function elements(parent: Document | Element, localName: string) {
  return Array.from(parent.getElementsByTagNameNS(word, localName));
}
function values(parent: Document | Element) {
  return elements(parent, "t")
    .map((entry) => entry.textContent)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
function attendanceTable(root: Document) {
  return elements(root, "tbl").find((entry) => {
    const firstCell = elements(entry, "tc")[0];
    return firstCell && values(firstCell) === "Date";
  })!;
}

describe("editable salary statements", () => {
  it("uses genuine OOXML A4 portrait, 19mm margins, Title style and footer page fields", async () => {
    const { entries, root } = await document();
    expect(entries.has("[Content_Types].xml")).toBe(true);
    const size = elements(root, "pgSz")[0];
    expect((Number(size.getAttributeNS(word, "w")) * 25.4) / 1440).toBeCloseTo(
      210,
      1,
    );
    expect((Number(size.getAttributeNS(word, "h")) * 25.4) / 1440).toBeCloseTo(
      297,
      1,
    );
    expect(size.getAttributeNS(word, "orient")).toBe("portrait");
    const margins = elements(root, "pgMar")[0];
    for (const side of ["top", "bottom", "left", "right"])
      expect(margins.getAttributeNS(word, side)).toBe("1077");
    const title = elements(root, "p").find(
      (p) => values(p) === "Employee Salary Statement",
    )!;
    expect(elements(title, "pStyle")[0].getAttributeNS(word, "val")).toBe(
      "Title",
    );
    expect(entries.get("word/footer1.xml")?.toString()).toMatch(/PAGE/);
    expect(entries.get("word/footer1.xml")?.toString()).toMatch(/NUMPAGES/);
    expect(entries.get("word/footer1.xml")?.toString()).toContain(
      "EMP001 · 2026-10",
    );
    const styles = new JSDOM(entries.get("word/styles.xml")!.toString(), {
      contentType: "application/xml",
    }).window.document;
    for (const name of ["Title", "Heading1"]) {
      const style = elements(styles, "style").find(
        (entry) => entry.getAttributeNS(word, "styleId") === name,
      )!;
      expect(elements(style, "color")[0].getAttributeNS(word, "val")).toBe(
        "000000",
      );
    }
    for (const borders of elements(root, "tblBorders"))
      for (const border of Array.from(borders.children))
        expect(border.getAttributeNS(word, "color")).toBe("D9D9D9");
    expect(SALARY_DOCX_MIME).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("places the complete preview amounts before one explicit attendance page break", async () => {
    const fixture = salaryStatementFixture();
    const { root, xml } = await document(fixture);
    const breaks = elements(root, "br").filter(
      (b) => b.getAttributeNS(word, "type") === "page",
    );
    expect(breaks).toHaveLength(1);
    const breakPosition = xml.indexOf('<w:br w:type="page"');
    for (const value of [
      "Monthly reference salary",
      "Fixed monthly divisor",
      "Payable days",
      "Range base salary",
      "Payable overtime duration",
      "Overtime hourly rate",
      "Overtime earnings",
      "Total calculated salary",
      "BDT 30,000.00",
      "BDT 24,230.77",
      "BDT 2,500.00",
      "BDT 26,730.77",
      "12h 30m",
      "31 inclusive calendar days − 10 office weekend days = 21 payable days",
      "BDT 30,000.00 ÷ 26 × 21 payable days = BDT 24,230.77",
    ]) {
      expect(xml.indexOf(value)).toBeGreaterThanOrEqual(0);
      expect(xml.indexOf(value)).toBeLessThan(breakPosition);
    }
    expect(xml.indexOf("Attendance Details")).toBeGreaterThan(breakPosition);
    expect(xml).not.toContain(fixture.token);
    expect(xml).not.toContain(fixture.employee.email);
    expect(xml).toContain("does not record payment or approval");
    const totalRow = elements(root, "tr").find((r) =>
      values(r).includes("Total calculated salary"),
    )!;
    const amount = elements(totalRow, "tc")[1];
    expect(elements(amount, "jc")[0].getAttributeNS(word, "val")).toBe("right");
    expect(elements(amount, "b")).not.toHaveLength(0);
  });

  it("retains every overflow row chronologically with repeated headers, unsplit rows and totals", async () => {
    const fixture = salaryStatementFixture({ rows: 80 });
    const { root } = await document(fixture);
    const attendance = attendanceTable(root);
    const rows = elements(attendance, "tr");
    expect(rows).toHaveLength(82);
    expect(elements(rows[0], "tblHeader")).toHaveLength(1);
    for (const row of rows) expect(elements(row, "cantSplit")).toHaveLength(1);
    const dates = rows
      .slice(1, -1)
      .map((row) => values(elements(row, "tc")[0]));
    expect(dates).toEqual([...dates].sort());
    expect(values(rows.at(-1)!)).toContain("80 records");
    const totalText = values(rows.at(-1)!);
    expect(totalText).toContain(
      `${Math.floor(fixture.summary.workedMinutes / 60)}h ${fixture.summary.workedMinutes % 60}m`,
    );
    expect(totalText).toContain(
      `${Math.floor(fixture.payableOvertimeMinutes / 60)}h ${fixture.payableOvertimeMinutes % 60}m`,
    );
  });

  it("shows an inclusive custom range on both pages and preserves its authoritative amounts and records", async () => {
    const fixture = salaryStatementFixture({
      period: "2026-09",
      from: "2026-09-20",
      to: "2026-09-30",
      monthlyBaseSalary: "18000.00",
      overtimePerRecordedDay: 125,
    });
    const { root, xml } = await document(fixture);
    const range = "20 Sept 2026 to 30 Sept 2026 inclusive";
    const breakPosition = xml.indexOf('<w:br w:type="page"');
    expect(xml.slice(0, breakPosition)).toContain(range);
    expect(values(root)).toContain(`Attendance range ${range}`);
    expect(xml.slice(breakPosition)).toContain(`${range} · EMP001`);
    expect(values(root)).toContain("Payroll month September 2026");
    expect(fixture.baseSalary).toBe("6230.77");
    expect(fixture.dailyRate).toBe("692.31");
    expect(fixture.totalSalary).toBe("8730.77");
    expect(values(root)).toContain("BDT 18,000.00");
    expect(values(root)).toContain("BDT 6,230.77");
    expect(values(root)).toContain("BDT 2,500.00");
    expect(values(root)).toContain("BDT 8,730.77");
    expect(values(root)).toContain(
      "11 inclusive calendar days − 2 office weekend days = 9 payable days",
    );
    expect(values(root)).toContain(
      "BDT 18,000.00 ÷ 26 × 9 payable days = BDT 6,230.77",
    );
    expect(values(root)).toContain("Office weekends: Friday, Saturday");
    expect(values(root)).toContain(
      "Payable overtime includes all selected attendance records",
    );
    expect(values(root)).not.toContain("full monthly base salary");
    expect(values(root)).not.toContain("Base salary is not prorated");
    const rows = elements(attendanceTable(root), "tr").slice(1, -1);
    expect(rows).toHaveLength(11);
    expect(rows.map((row) => values(elements(row, "tc")[0]))).toEqual(
      Array.from({ length: 11 }, (_, index) => `${index + 20} Sept 2026`),
    );
    for (const weekendDate of ["25 Sept 2026", "26 Sept 2026"]) {
      const row = rows.find(
        (entry) => values(elements(entry, "tc")[0]) === weekendDate,
      )!;
      expect(values(elements(row, "tc")[4])).toBe("2h 5m");
    }
    expect(values(attendanceTable(root))).not.toContain("19 Sept 2026");
    expect(values(attendanceTable(root))).not.toContain("01 Oct 2026");
    expect(
      salaryStatementFilename(
        "EMP001",
        fixture.period,
        fixture.from,
        fixture.to,
      ),
    ).toBe("salary-statement-EMP001-2026-09-20-to-2026-09-30.docx");
  });

  it("rejects attendance outside the authoritative inclusive range rather than changing preview totals", async () => {
    const fixture = salaryStatementFixture({
      period: "2026-09",
      from: "2026-09-19",
      to: "2026-09-30",
    });
    fixture.attendance[0] = { ...fixture.attendance[0], date: "2026-09-18" };
    await expect(salaryStatementDocx(fixture, { logo: null })).rejects.toThrow(
      "Salary attendance falls outside the selected date range",
    );
  });

  it("adds an editable blank acknowledgment form before attendance without asserting payment or approval", async () => {
    const fixture = salaryStatementFixture({ longName: true, ongoing: true });
    const { root, xml } = await document(fixture);
    const breakPosition = xml.indexOf('<w:br w:type="page"');
    const acknowledgment = xml.indexOf("Acknowledgment");
    expect(acknowledgment).toBeGreaterThan(
      xml.indexOf("Total calculated salary"),
    );
    expect(acknowledgment).toBeLessThan(breakPosition);
    const form = xml.slice(
      xml.indexOf("Employee acknowledgment"),
      breakPosition,
    );
    for (const field of [
      "Employee acknowledgment",
      "Prepared by",
      "Signature",
      "Date",
      "Name",
    ])
      expect(form).toContain(field);
    expect(form.match(/Signature /g)).toHaveLength(2);
    expect(form.match(/Date /g)).toHaveLength(2);
    expect(form.match(/Name /g)).toHaveLength(1);
    expect(form.match(/<w:tab\/>/g)).toHaveLength(4);
    expect(form).not.toContain(fixture.employee.name);
    expect(form).not.toContain("<w:tbl>");
    expect(values(root)).toContain(
      "Signing acknowledges receipt and review of this statement only. It does not record payment or approval.",
    );
    const paragraphs = elements(root, "p").filter((paragraph) => {
      const text = values(paragraph);
      return (
        text.includes("Employee acknowledgment") ||
        text.includes("Signature ") ||
        text.includes("Name ")
      );
    });
    expect(paragraphs).toHaveLength(3);
    for (const paragraph of paragraphs) {
      expect(elements(paragraph, "tabs")).toHaveLength(1);
      expect(elements(paragraph, "keepNext")).toHaveLength(1);
    }
    expect(elements(root, "tbl")).toHaveLength(2);
  });

  it("wraps long names, omits unavailable logo and optional data, and distinguishes attendance classifications", async () => {
    const fixture = salaryStatementFixture({ longName: true, ongoing: true });
    const { entries, root, xml } = await document(fixture);
    expect(xml).toContain(fixture.employee.name);
    expect(
      Array.from(entries.keys()).some(
        (name) => name.startsWith("word/media/") && !name.endsWith("/"),
      ),
    ).toBe(false);
    const text = values(root);
    expect(text).toContain("Provisional calculation for an ongoing month");
    for (const status of [
      "Leave",
      "Holiday",
      "Weekend",
      "Absent",
      "Incomplete",
      "Late",
      "Present",
    ])
      expect(text).toContain(status);
    expect(text).toContain("—");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("null");
    expect(
      elements(root, "tblLayout").every(
        (layout) => layout.getAttributeNS(word, "type") === "fixed",
      ),
    ).toBe(true);
  });

  it("shows overnight timestamp dates in the attendance timezone and signed authoritative earnings", async () => {
    const fixture = salaryStatementFixture({ rows: 1 });
    fixture.attendance[0] = {
      ...fixture.attendance[0],
      status: "PRESENT",
      actualStatus: "PRESENT",
      derived: false,
      checkInAt: "2026-10-01T16:00:00.000Z",
      checkOutAt: "2026-10-02T01:00:00.000Z",
      workedMinutes: 540,
      payableOvertimeMinutes: -90,
    };
    fixture.payableOvertimeMinutes = -90;
    fixture.overtimeEarnings = "-300.00";
    fixture.totalSalary = "23930.77";
    fixture.summary.workedMinutes = 540;
    fixture.summary.payableOvertimeMinutes = -90;
    const { root } = await document(fixture);
    const text = values(root);
    expect(text).toContain("22:00");
    expect(text).toContain("07:00 02 Oct 2026");
    expect(text).toContain("−1h 30m");
    expect(text).toContain("-BDT 300.00");
    expect(text).toContain("BDT 23,930.77");
    expect(text).toContain("existing signed time adjustments");
  });

  it("embeds the existing company logo when available and generates safe attachment names", async () => {
    const bytes = await salaryStatementDocx(salaryStatementFixture());
    const entries = unzip(bytes);
    expect(
      Array.from(entries.keys()).some(
        (name) => name.startsWith("word/media/") && !name.endsWith("/"),
      ),
    ).toBe(true);
    expect(salaryStatementFilename("EMP001", "2026-10")).toBe(
      "salary-statement-EMP001-2026-10.docx",
    );
    expect(
      salaryStatementFilename("EMP001", "2026-10", "2026-10-01", "2026-10-31"),
    ).toBe("salary-statement-EMP001-2026-10.docx");
    expect(
      salaryStatementFilename("EMP001", "2028-02", "2028-02-01", "2028-02-29"),
    ).toBe("salary-statement-EMP001-2028-02.docx");
    for (const [from, to] of [
      ["2026-09-31", "2026-09-31"],
      ["2026-09-30", "2026-09-19"],
      ["2026-09-19", "../../bad"],
      ["2026-09-19", undefined],
    ])
      expect(() =>
        salaryStatementFilename("EMP001", "2026-09", from, to),
      ).toThrow("Invalid salary date range");
    expect(salaryStatementFilename('EMP/../\"\\\r\n001', "2026-10")).toBe(
      "salary-statement-EMP-001-2026-10.docx",
    );
    expect(salaryStatementFilename("💼", "2026-10")).toBe(
      "salary-statement-employee-2026-10.docx",
    );
    expect(() => salaryStatementFilename("EMP001", "2026-00")).toThrow(
      "Invalid payroll month",
    );
  });
});
