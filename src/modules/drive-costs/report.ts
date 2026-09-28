import "server-only";
import { createTranslator } from "next-intl";
import { resolveLocale, type Locale } from "@/i18n/config";
import { withEnglishFallback } from "@/i18n/messages";
import en from "../../../messages/en/expenses.json";
import zh from "../../../messages/zh-CN/expenses.json";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { authorizeRole } from "@/modules/auth/authorization";
import type { Actor } from "@/modules/management/permissions";
import { DomainError } from "@/lib/errors";
import { createReportPdf } from "@/modules/reports/pdf";
import { driveCostWhere, type DriveCostFilters } from "./filters";

const MAX_REPORT_ROWS = 10000;
const reportSelect = {
  date: true,
  destinationFrom: true,
  destinationTo: true,
  kilometers: true,
  isRoundTrip: true,
  rateType: true,
  ratePerKilometer: true,
  totalCost: true,
} satisfies Prisma.DriveCostSelect;

export async function getDriveCostReport(
  actor: Actor,
  filters: DriveCostFilters,
  requestedLocale: Locale = "en",
) {
  authorizeRole(actor.role, "MANAGE_DRIVER");
  const locale = resolveLocale(requestedLocale);
  const t = createTranslator({
    locale,
    messages: locale === "en" ? en : withEnglishFallback(en, zh),
  });
  // Fetch the complete filtered set in one bounded query. Summing these same
  // rows keeps the PDF detail and totals consistent during concurrent edits.
  const records = await db.driveCost.findMany({
    where: driveCostWhere(filters),
    select: reportSelect,
    orderBy: [{ date: "desc" }, { id: "desc" }],
    take: MAX_REPORT_ROWS + 1,
  });
  if (records.length > MAX_REPORT_ROWS)
    throw new DomainError(
      "REPORT_TOO_LARGE",
      "Choose a narrower date range or destination search to export 10,000 trips or fewer.",
    );

  let kilometers = new Prisma.Decimal(0);
  let totalCost = new Prisma.Decimal(0);
  let inTimeCost = new Prisma.Decimal(0);
  let overTimeCost = new Prisma.Decimal(0);
  for (const record of records) {
    kilometers = kilometers.add(
      record.kilometers.mul(record.isRoundTrip ? 2 : 1),
    );
    totalCost = totalCost.add(record.totalCost);
    if (record.rateType === "IN_TIME")
      inTimeCost = inTimeCost.add(record.totalCost);
    else overTimeCost = overTimeCost.add(record.totalCost);
  }

  const { from, to, q, paymentStatus } = filters;
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
  const bytes = await createReportPdf({
    title: t("driveReportTitle"),
    locale,
    subtitle: [
      period,
      ...(q ? [t("reportDestinationSearch", { search: q })] : []),
      ...(paymentStatus
        ? [t("reportPaymentStatus", { status: paymentStatus })]
        : []),
    ],
    dateGroupColumn: 0,
    summary: [
      {
        label: t("reportTotalTrips"),
        value: records.length.toLocaleString(locale),
      },
      { label: t("reportTotalKilometers"), value: kilometers.toFixed(2) },
      { label: t("reportTotalCost"), value: totalCost.toFixed(2) },
      { label: t("reportInTimeCost"), value: inTimeCost.toFixed(2) },
      { label: t("reportOverTimeCost"), value: overTimeCost.toFixed(2) },
    ],
    columns: [
      { label: t("date"), width: 78 },
      { label: t("from"), width: 120 },
      { label: t("to"), width: 120 },
      { label: t("tripType"), width: 99 },
      { label: t("rateType"), width: 65 },
      { label: t("totalKm"), width: 66, align: "right" },
      { label: t("reportRate"), width: 85, align: "right" },
      { label: t("reportTotalBdt"), width: 89, align: "right" },
    ],
    rows: records.map((record) => [
      record.date.toISOString().slice(0, 10),
      record.destinationFrom,
      record.destinationTo,
      record.isRoundTrip ? t("roundTrip") : t("oneWay"),
      record.rateType === "IN_TIME" ? t("reportInTime") : t("reportOvertime"),
      record.kilometers.mul(record.isRoundTrip ? 2 : 1).toFixed(2),
      record.ratePerKilometer.toFixed(2),
      record.totalCost.toFixed(2),
    ]),
    footerNote: t("driveReportFooter"),
  });
  const filenamePeriod =
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
      "Content-Disposition": `attachment; filename="drive-cost-${filenamePeriod}.pdf"`,
    },
  });
}
