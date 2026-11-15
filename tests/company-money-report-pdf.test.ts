import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, beforeEach, mock, test } from "node:test";
import type { CompanyMoneyReportData } from "../src/modules/company-money/contracts";
import type { PdfReport } from "../src/modules/reports/pdf";

function fixture(): CompanyMoneyReportData {
  return {
    generatedAt: "2026-11-14T23:30:00.000Z",
    filters: { from: "2026-11-01", to: "2026-11-30" },
    summary: {
      openingBalance: "-100.01",
      totalAdded: "250.35",
      totalRemoved: "25.15",
      closingBalance: "125.19",
      count: 2,
    },
    items: [
      {
        id: "addition-1",
        version: 1,
        type: "ADD",
        amount: "250.35",
        date: "2026-11-14",
        note: "Operating funds",
        createdAt: "2026-11-14T23:30:00.000Z",
        createdBy: { name: "Office Admin", email: "admin@example.test" },
      },
      {
        id: "removal-1",
        version: 1,
        type: "REMOVE",
        amount: "25.15",
        date: "2026-11-01",
        note: null,
        createdAt: "2026-11-01T09:30:00.000Z",
        createdBy: null,
      },
    ],
  };
}

let data = fixture();
const pdfBytes = new TextEncoder().encode("%PDF-1.7\ncompany money fixture");
const render = mock.fn(async (report: PdfReport) => {
  void report;
  return pdfBytes;
});
const getData = mock.fn(async (...args: unknown[]) => {
  void args;
  return data;
});
let report: typeof import("../src/modules/company-money/report");
let realRender: typeof import("../src/modules/reports/pdf").createReportPdf;

before(async () => {
  // Next provides the server/client boundary for next-intl's provider exports.
  // In a standalone Node test, keep the real ICU translator without loading
  // client React contexts under the react-server condition.
  const projectRequire = createRequire(`${process.cwd()}/package.json`);
  const intlRequire = createRequire(projectRequire.resolve("next-intl"));
  const { createTranslator } = await import(
    intlRequire.resolve("use-intl/core")
  );
  mock.module("next-intl", { namedExports: { createTranslator } });
  realRender = (await import("../src/modules/reports/pdf")).createReportPdf;
  mock.module("../src/modules/reports/pdf.ts", {
    namedExports: { createReportPdf: render },
  });
  mock.module("../src/modules/company-money/service.ts", {
    namedExports: { getCompanyMoneyReportData: getData },
  });
  report = await import("../src/modules/company-money/report");
});

beforeEach(() => {
  data = fixture();
  render.mock.resetCalls();
  getData.mock.resetCalls();
});

after(() => mock.restoreAll());

function rendered() {
  assert.equal(render.mock.callCount(), 1);
  return render.mock.calls[0].arguments[0];
}

test("PDF includes period balances, exact signed BDT amounts and Dhaka timestamps", async () => {
  await report.createCompanyMoneyReportPdf(data);
  const pdf = rendered();
  assert.equal(pdf.title, "Company money report");
  assert.equal(pdf.locale, "en");
  assert.match(pdf.subtitle[0], /2026-11-01.*2026-11-30/);
  assert.match(pdf.subtitle[1], /BDT.*Asia\/Dhaka/);
  assert.match(pdf.subtitle[2], /Nov 15, 2026.*05:30:00/);
  assert.deepEqual(
    pdf.summary.map(({ value }) => value),
    ["-BDT 100.01", "BDT 250.35", "BDT 25.15", "BDT 125.19", "2"],
  );
  assert.equal(pdf.rows.length, 2);
  assert.equal(pdf.rows[0][0], "2026-11-14");
  assert.match(pdf.rows[0][1], /Nov 15, 2026.*05:30:00/);
  assert.deepEqual(pdf.rows[0].slice(2), [
    "Added",
    "+BDT 250.35",
    "Operating funds",
    "Office Admin\nadmin@example.test",
  ]);
  assert.deepEqual(pdf.rows[1].slice(2), [
    "Removed",
    "-BDT 25.15",
    "-",
    "Deleted user",
  ]);
  assert.match(pdf.footerNote ?? "", /current transaction records/);
});

test("Chinese report localizes headings, types and deleted-user fallback", async () => {
  await report.createCompanyMoneyReportPdf(data, "zh-CN");
  const pdf = rendered();
  assert.equal(pdf.locale, "zh-CN");
  assert.match(pdf.title, /公司/);
  assert.notEqual(pdf.title, "Company money report");
  assert.notEqual(pdf.summary[0].label, "Opening balance");
  assert.notEqual(pdf.rows[0][2], "Added");
  assert.notEqual(pdf.rows[1][5], "Deleted user");
  assert.equal(pdf.rows[0][3], "+BDT 250.35");
});

test("empty periods preserve their opening and closing balance", async () => {
  data.items = [];
  data.summary = {
    openingBalance: "123456789012345678901234567890.01",
    closingBalance: "123456789012345678901234567890.01",
    totalAdded: "0.00",
    totalRemoved: "0.00",
    count: 0,
  };
  await report.createCompanyMoneyReportPdf(data);
  const pdf = rendered();
  assert.deepEqual(pdf.rows, []);
  assert.equal(
    pdf.summary[0].value,
    "BDT 123,456,789,012,345,678,901,234,567,890.01",
  );
  assert.equal(pdf.summary[3].value, pdf.summary[0].value);
  assert.equal(pdf.summary[4].value, "0");
});

test("long multilingual notes and unnamed creators are passed through in full", async () => {
  const note = "办公费用 বাংলা নোট ".repeat(25);
  data.items[0].note = note;
  data.items[0].createdBy = { name: null, email: "office@example.test" };
  await report.createCompanyMoneyReportPdf(data);
  const pdf = rendered();
  assert.equal(pdf.rows[0][4], note);
  assert.equal(pdf.rows[0][5], "office@example.test");
});

for (const [filters, period, subtitle] of [
  [{}, "all-dates", /All transaction dates/],
  [{ from: "2026-11-01" }, "from-2026-11-01", /from 2026-11-01/],
  [{ to: "2026-11-30" }, "through-2026-11-30", /through 2026-11-30/],
  [
    { from: "2026-11-15", to: "2026-11-15" },
    "2026-11-15",
    /Transaction date: 2026-11-15/,
  ],
  [
    { from: "2026-11-01", to: "2026-11-30" },
    "2026-11-01-2026-11-30",
    /2026-11-01.*2026-11-30/,
  ],
] as const) {
  test(`PDF response uses the ${period} period and safe attachment headers`, async () => {
    data.filters = filters;
    const actor = { id: "admin-1", role: "ADMIN" as const };
    const response = await report.getCompanyMoneyReport(actor, filters, "en");
    assert.deepEqual(getData.mock.calls[0].arguments, [actor, filters]);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/pdf");
    assert.equal(
      response.headers.get("Content-Disposition"),
      `attachment; filename="company-money-${period}.pdf"`,
    );
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), pdfBytes);
    assert.match(rendered().subtitle[0], subtitle);
  });
}

test("shared renderer generates a real multipage PDF for the report layout", async () => {
  data.items = Array.from({ length: 50 }, (_, index) => ({
    ...data.items[index % 2],
    id: `record-${index}`,
    note:
      index === 0
        ? "办公费用 বাংলা নোট with a long transaction description. ".repeat(10)
        : `Transaction ${index}`,
  }));
  data.summary.count = data.items.length;
  await report.createCompanyMoneyReportPdf(data, "zh-CN");
  const bytes = await realRender(rendered());
  const content = Buffer.from(bytes).toString("latin1");
  assert.match(content, /^%PDF-/);
  assert.ok((content.match(/\/Type \/Page\b/g) ?? []).length > 1);
  assert.match(content, /%%EOF/);
});
