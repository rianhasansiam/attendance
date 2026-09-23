import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
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

export async function getDriveCostReport(filters: DriveCostFilters) {
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

  const { from, to, q } = filters;
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
  const bytes = await createReportPdf({
    title: "Drive cost report",
    subtitle: [period, ...(q ? [`Destination search: ${q}`] : [])],
    dateGroupColumn: 0,
    summary: [
      { label: "Total trips", value: records.length.toLocaleString("en-US") },
      { label: "Total kilometers", value: kilometers.toFixed(2) },
      { label: "Total cost (BDT)", value: totalCost.toFixed(2) },
      { label: "In-time cost (BDT)", value: inTimeCost.toFixed(2) },
      { label: "Overtime cost (BDT)", value: overTimeCost.toFixed(2) },
    ],
    columns: [
      { label: "Date", width: 78 },
      { label: "From", width: 120 },
      { label: "To", width: 120 },
      { label: "Trip type", width: 99 },
      { label: "Rate type", width: 65 },
      { label: "Total km", width: 66, align: "right" },
      { label: "Rate (BDT/km)", width: 85, align: "right" },
      { label: "Total (BDT)", width: 89, align: "right" },
    ],
    rows: records.map((record) => [
      record.date.toISOString().slice(0, 10),
      record.destinationFrom,
      record.destinationTo,
      record.isRoundTrip ? "Round trip (×2)" : "One way",
      record.rateType === "IN_TIME" ? "In-time" : "Overtime",
      record.kilometers.mul(record.isRoundTrip ? 2 : 1).toFixed(2),
      record.ratePerKilometer.toFixed(2),
      record.totalCost.toFixed(2),
    ]),
    footerNote:
      "All matching trips are included. Round-trip kilometers include the return journey (×2). Amounts use each trip's saved rate and are shown in Bangladeshi taka (BDT).",
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
