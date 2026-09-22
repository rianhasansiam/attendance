import { formatInTimeZone } from "date-fns-tz";
import type { z } from "zod";
import type { reportFilterSchema } from "@/modules/management/validation";
import { addCalendarDays } from "@/modules/shifts/calculations";
import type { ReportRecord } from "./service";
import { createReportPdf } from "./pdf";

function duration(minutes: number) {
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export async function attendanceReportPdf(
  records: ReportRecord[],
  filters: z.infer<typeof reportFilterSchema>,
  now: Date,
) {
  const to = filters.to ?? now.toISOString().slice(0, 10);
  const from = filters.from ?? addCalendarDays(to, -29);
  const subtitle = [`Date range: ${from} to ${to}`];
  if (filters.employeeId) {
    const employee = records.find(
      (row) => row.employee.id === filters.employeeId,
    )?.employee;
    subtitle.push(
      `Employee: ${employee ? `${employee.user.name || employee.employeeCode} (${employee.employeeCode})` : "Selected employee"}`,
    );
  }
  if (filters.departmentId)
    subtitle.push(
      `Department: ${records[0]?.employee.department?.name || "Selected department"}`,
    );
  if (filters.officeId)
    subtitle.push(`Office: ${records[0]?.office.name || "Selected office"}`);
  if (filters.shiftId)
    subtitle.push(`Shift: ${records[0]?.shift.name || "Selected shift"}`);
  if (filters.status)
    subtitle.push(`Status: ${filters.status.replaceAll("_", " ")}`);

  let worked = 0;
  let overtime = 0;
  let unknown = 0;
  for (const row of records) {
    worked += row.workedMinutes;
    if (row.overtimeMinutes === null) unknown++;
    else overtime += row.overtimeMinutes;
  }
  const bytes = await createReportPdf({
    title: "Attendance report",
    subtitle,
    summary: [
      { label: "Records", value: String(records.length) },
      { label: "Total worked", value: duration(worked) },
      {
        label: "Total overtime",
        value: `${duration(overtime)} (${overtime} min)`,
      },
    ],
    columns: [
      { label: "Date", width: 65 },
      { label: "Employee / ID", width: 108 },
      { label: "Office / Shift / Timezone", width: 106 },
      { label: "Check in", width: 65 },
      { label: "Check out", width: 65 },
      { label: "Worked", width: 57 },
      { label: "Overtime", width: 66 },
      { label: "Late (min)", width: 40, align: "right" },
      { label: "Status", width: 72 },
      { label: "Late reason", width: 100 },
    ],
    rows: records.map((row) => {
      const zone = row.shift.timezone;
      const punch = (value: Date | null) =>
        value
          ? `${formatInTimeZone(value, zone, "yyyy-MM-dd")}\n${formatInTimeZone(value, zone, "HH:mm")}`
          : "-";
      return [
        row.attendanceDate.toISOString().slice(0, 10),
        `${row.employee.user.name || row.employee.employeeCode}\n${row.employee.employeeCode}`,
        `${row.office.name}\n${row.shift.name}\n${zone}`,
        punch(row.checkInAt),
        punch(row.checkOutAt),
        duration(row.workedMinutes),
        row.overtimeMinutes === null
          ? "Unknown"
          : duration(row.overtimeMinutes),
        String(row.lateMinutes),
        `${row.status.replaceAll("_", " ")}${row.derived ? "\nScheduled day" : ""}`,
        row.lateReason || "-",
      ];
    }),
    footerNote: `Times use each row's shift timezone. Overtime counts completed minutes.${unknown ? ` Total excludes ${unknown} record${unknown === 1 ? "" : "s"} with unknown overtime.` : ""}`,
  });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="attendance-${from}-to-${to}.pdf"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
