import "server-only";
import { createTranslator } from "next-intl";
import { resolveLocale, type Locale } from "@/i18n/config";
import { withEnglishFallback } from "@/i18n/messages";
import { formatMoney } from "@/i18n/format-money";
import { createReportPdf } from "@/modules/reports/pdf";
import type { Actor } from "@/modules/management/permissions";
import en from "../../../messages/en/admin.json";
import zh from "../../../messages/zh-CN/admin.json";
import type { CompanyMoneyReportData } from "./contracts";
import { getCompanyMoneyReportData } from "./service";

const timezone = "Asia/Dhaka";
const currency = "BDT";

export function createCompanyMoneyReportPdf(
  data: CompanyMoneyReportData,
  requestedLocale: Locale = "en",
) {
  const locale = resolveLocale(requestedLocale);
  const t = createTranslator({
    locale,
    messages: locale === "en" ? en : (withEnglishFallback(en, zh) as typeof en),
    namespace: "companyMoney",
  });
  const { from, to } = data.filters;
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
  const money = (amount: string) => formatMoney(amount, currency, locale);
  const timestamp = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: timezone,
    timeZoneName: "short",
    hour12: false,
  });

  return createReportPdf({
    title: t("reportTitle"),
    locale,
    subtitle: [
      period,
      t("reportCurrencyTimezone", { currency, timezone }),
      t("reportGenerated", {
        time: timestamp.format(new Date(data.generatedAt)),
      }),
    ],
    summary: [
      { label: t("openingBalance"), value: money(data.summary.openingBalance) },
      { label: t("totalAdded"), value: money(data.summary.totalAdded) },
      { label: t("totalRemoved"), value: money(data.summary.totalRemoved) },
      { label: t("closingBalance"), value: money(data.summary.closingBalance) },
      {
        label: t("reportRecords"),
        value: data.summary.count.toLocaleString(locale),
      },
    ],
    columns: [
      { label: t("transactionDate"), width: 82 },
      { label: t("dateTime"), width: 122 },
      { label: t("type"), width: 65 },
      { label: t("amountBdt"), width: 105, align: "right" },
      { label: t("note"), width: 220 },
      { label: t("recordedBy"), width: 174 },
    ],
    rows: data.items.map((item) => [
      item.date,
      timestamp.format(new Date(item.createdAt)),
      t(item.type === "ADD" ? "added" : "removed"),
      `${item.type === "ADD" ? "+" : "-"}${money(item.amount)}`,
      item.note || "-",
      item.createdBy
        ? item.createdBy.name
          ? `${item.createdBy.name}\n${item.createdBy.email}`
          : item.createdBy.email
        : t("deletedUser"),
    ]),
    footerNote: t("reportFooter"),
  });
}

export async function getCompanyMoneyReport(
  actor: Actor,
  raw: unknown = {},
  locale: Locale = "en",
): Promise<Response> {
  const data = await getCompanyMoneyReportData(actor, raw);
  const bytes = await createCompanyMoneyReportPdf(data, locale);
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
      "Content-Disposition": `attachment; filename="company-money-${period}.pdf"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
