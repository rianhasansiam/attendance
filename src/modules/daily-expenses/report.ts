import "server-only";
import { createReportPdf } from "@/modules/reports/pdf";
import { formatMoney, type DailyExpenseReportData } from "./contracts";
import type { DailyExpensesActor } from "./permissions";
import { getDailyExpenseReportData } from "./service";

export function createDailyExpenseReportPdf(data: DailyExpenseReportData) {
  const { from, to, type, search } = data.filters;
  const period =
    from && to
      ? from === to
        ? `Date: ${from}`
        : `Period: ${from} to ${to} (inclusive)`
      : from
        ? `From: ${from} onward`
        : to
          ? `Through: ${to} (inclusive)`
          : "Period: All dates";
  const money = (amount: string) => formatMoney(amount, data.ledger.currency);
  const generatedAt = new Date(data.generatedAt)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");

  return createReportPdf({
    title: "Daily Expenses report",
    subtitle: [
      period,
      `Type: ${type === "EXPENSE" ? "Expense" : type === "BALANCE_ADDED" ? "Balance added" : "All types"} | Category: ${data.categoryName ?? "All categories"}`,
      ...(search ? [`Note search: ${search}`] : []),
      `Currency: ${data.ledger.currency} | Business timezone: ${data.ledger.timezone}`,
      `Generated: ${generatedAt}`,
    ],
    summary: [
      {
        label: "All-time current balance",
        value: money(data.allTime.currentBalance),
      },
      {
        label: "All-time balance added",
        value: money(data.allTime.totalBalanceAdded),
      },
      { label: "All-time expenses", value: money(data.allTime.totalExpenses) },
      {
        label: "Filtered records",
        value: data.filtered.count.toLocaleString("en-US"),
      },
      {
        label: "Filtered balance added",
        value: money(data.filtered.totalBalanceAdded),
      },
      { label: "Filtered expenses", value: money(data.filtered.totalExpenses) },
      { label: "Filtered net change", value: money(data.filtered.netChange) },
    ],
    columns: [
      { label: "Date", width: 78 },
      { label: "Type", width: 85 },
      { label: "Category", width: 105 },
      { label: "Note", width: 210 },
      { label: "Recorded by", width: 180 },
      { label: `Amount (${data.ledger.currency})`, width: 110, align: "right" },
    ],
    rows: data.items.map((item) => [
      item.date,
      item.type === "EXPENSE" ? "Expense" : "Balance added",
      item.category?.name ?? "-",
      item.note || "-",
      item.createdBy.name
        ? `${item.createdBy.name}\n${item.createdBy.email}`
        : item.createdBy.email,
      `${item.type === "EXPENSE" ? "-" : "+"}${money(item.amount)}`,
    ]),
    footerNote:
      "All matching records across every history page are included. Deleted records are excluded. All-time balances ignore the selected filters; filtered net change is balance added minus expenses in this report. Positive amounts add funds and negative amounts record expenses.",
  });
}

export async function getDailyExpenseReport(
  actor: DailyExpensesActor,
  raw: unknown = {},
): Promise<Response> {
  const data = await getDailyExpenseReportData(actor, raw);
  const bytes = await createDailyExpenseReportPdf(data);
  const { from, to } = data.filters;
  const period =
    from && to
      ? from === to
        ? from
        : `${from}-${to}`
      : from
        ? `from-${from}`
        : to
          ? `through-${to}`
          : "all-dates";
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="daily-expenses-${period}.pdf"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
