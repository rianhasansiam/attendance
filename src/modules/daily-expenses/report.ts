import "server-only";
import { createReportPdf } from "@/modules/reports/pdf";
import { createTranslator } from "next-intl";
import { resolveLocale, type Locale } from "@/i18n/config";
import { withEnglishFallback } from "@/i18n/messages";
import { formatMoney } from "@/i18n/format-money";
import en from "../../../messages/en/expenses.json";
import zh from "../../../messages/zh-CN/expenses.json";
import { type DailyExpenseReportData } from "./contracts";
import type { DailyExpensesActor } from "./permissions";
import { getDailyExpenseReportData } from "./service";

export function createDailyExpenseReportPdf(
  data: DailyExpenseReportData,
  requestedLocale: Locale = "en",
) {
  const locale = resolveLocale(requestedLocale);
  const t = createTranslator({
    locale,
    messages: locale === "en" ? en : withEnglishFallback(en, zh),
  });
  const { from, to, type, search } = data.filters;
  const period =
    from && to
      ? from === to
        ? t("reportDate", { date: from })
        : t("reportPeriod", { from, to })
      : from
        ? t("reportFrom", { from })
        : to
          ? t("reportThrough", { to })
          : t("reportAllDates");
  const money = (amount: string) =>
    formatMoney(amount, data.ledger.currency, locale);
  const generatedAt = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
    hour12: false,
  }).format(new Date(data.generatedAt));

  return createReportPdf({
    title: t("dailyReportTitle"),
    locale,
    subtitle: [
      period,
      t("reportTypeCategory", {
        type: type ?? "all",
        category: data.categoryName ?? t("allCategories"),
      }),
      ...(search ? [t("reportNoteSearch", { search })] : []),
      t("reportCurrencyTimezone", {
        currency: data.ledger.currency,
        timezone: data.ledger.timezone,
      }),
      t("reportGenerated", { time: generatedAt }),
    ],
    summary: [
      {
        label: t("allTimeBalance"),
        value: money(data.allTime.currentBalance),
      },
      {
        label: t("allTimeAdded"),
        value: money(data.allTime.totalBalanceAdded),
      },
      { label: t("allTimeExpenses"), value: money(data.allTime.totalExpenses) },
      {
        label: t("filteredRecords"),
        value: data.filtered.count.toLocaleString(locale),
      },
      {
        label: t("filteredAdded"),
        value: money(data.filtered.totalBalanceAdded),
      },
      {
        label: t("filteredExpenses"),
        value: money(data.filtered.totalExpenses),
      },
      { label: t("filteredNetChange"), value: money(data.filtered.netChange) },
    ],
    columns: [
      { label: t("date"), width: 78 },
      { label: t("type"), width: 85 },
      { label: t("category"), width: 105 },
      { label: t("reportNote"), width: 210 },
      { label: t("recordedBy"), width: 180 },
      {
        label: t("amountCurrency", { currency: data.ledger.currency }),
        width: 110,
        align: "right",
      },
    ],
    rows: data.items.map((item) => [
      item.date,
      item.type === "EXPENSE" ? t("expense") : t("balanceAdded"),
      item.category?.name ?? "-",
      item.note || "-",
      item.createdBy
        ? item.createdBy.name
          ? `${item.createdBy.name}\n${item.createdBy.email}`
          : item.createdBy.email
        : t("deletedInfo"),
      `${item.type === "EXPENSE" ? "-" : "+"}${money(item.amount)}`,
    ]),
    footerNote: t("dailyReportFooter"),
  });
}

export async function getDailyExpenseReport(
  actor: DailyExpensesActor,
  raw: unknown = {},
  locale: Locale = "en",
): Promise<Response> {
  const data = await getDailyExpenseReportData(actor, raw);
  const bytes = await createDailyExpenseReportPdf(data, locale);
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
