import type { z } from "zod";
import type { reportFilterSchema } from "@/modules/management/validation";
import { addCalendarDays } from "@/modules/shifts/calculations";
import {
  countedOvertimeMinutes,
  isCountedOvertime,
} from "@/modules/attendance/overtime-policy";
import type { ReportRecord } from "./service";
import { resolveLocale } from "@/i18n/config";
import { createReportTranslator } from "./translations";
import { createReportPdf } from "./pdf";

export async function attendanceReportPdf(
  records: ReportRecord[],
  filters: z.infer<typeof reportFilterSchema>,
  now: Date,
  selectedLocale = "en",
) {
  const locale = resolveLocale(selectedLocale);
  const t = createReportTranslator(locale);
  const number = new Intl.NumberFormat(locale);
  // Keep the existing ISO-shaped English export dates; date-only values always
  // remain in UTC, while punches use each row's configured shift timezone.
  const dateLocale = { en: "en-CA", "zh-CN": "zh-CN" }[locale];
  const date = (value: Date, timeZone = "UTC") =>
    new Intl.DateTimeFormat(dateLocale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone,
    }).format(value);
  const duration = (minutes: number) => {
    const magnitude = Math.abs(minutes);
    return t("attendance.duration", {
      sign: minutes < 0 ? "-" : "",
      hours: Math.floor(magnitude / 60),
      minutes: magnitude % 60,
    });
  };
  const to = filters.to ?? now.toISOString().slice(0, 10);
  const from = filters.from ?? addCalendarDays(to, -29);
  const subtitle = [
    t("attendance.dateRange", {
      from: date(new Date(`${from}T00:00:00Z`)),
      to: date(new Date(`${to}T00:00:00Z`)),
    }),
  ];
  if (filters.employeeId) {
    const employee = records.find(
      (row) => row.employee?.id === filters.employeeId,
    )?.employee;
    subtitle.push(
      t("attendance.employee", {
        name: employee
          ? `${employee.user.name || employee.employeeCode} (${employee.employeeCode})`
          : t("attendance.selectedEmployee"),
      }),
    );
  }
  if (filters.departmentId)
    subtitle.push(
      t("attendance.department", {
        name:
          records[0]?.employee?.department?.name ||
          t("attendance.selectedDepartment"),
      }),
    );
  if (filters.officeId)
    subtitle.push(
      t("attendance.office", {
        name: records[0]?.office.name || t("attendance.selectedOffice"),
      }),
    );
  if (filters.shiftId)
    subtitle.push(
      t("attendance.shift", {
        name: records[0]?.shift.name || t("attendance.selectedShift"),
      }),
    );
  if (filters.status)
    subtitle.push(
      t("attendance.statusFilter", { status: t(`status.${filters.status}`) }),
    );

  let worked = 0;
  let overtime = 0;
  let unknown = 0;
  for (const row of records) {
    worked += row.workedMinutes;
    if (row.overtimeMinutes === null) unknown++;
    overtime += countedOvertimeMinutes(
      row.overtimeMinutes,
      row.lateMinutes,
      row.checkInAt && row.checkOutAt ? row.workedMinutes : null,
    );
  }
  const bytes = await createReportPdf({
    locale,
    title: t("attendance.title"),
    subtitle,
    dateGroupColumn: 0,
    summary: [
      { label: t("attendance.records"), value: number.format(records.length) },
      { label: t("attendance.totalWorked"), value: duration(worked) },
      {
        label: t("attendance.totalOvertime"),
        value: t("attendance.overtimeTotal", {
          duration: duration(overtime),
          minutes: overtime,
        }),
      },
    ],
    columns: [
      { label: t("attendance.date"), width: 65 },
      { label: t("attendance.employeeId"), width: 108 },
      { label: t("attendance.officeShiftTimezone"), width: 106 },
      { label: t("attendance.checkIn"), width: 65 },
      { label: t("attendance.checkOut"), width: 65 },
      { label: t("attendance.worked"), width: 57 },
      { label: t("attendance.overtime"), width: 66 },
      { label: t("attendance.actualLate"), width: 40, align: "right" },
      { label: t("attendance.status"), width: 72 },
      { label: t("attendance.lateReason"), width: 100 },
    ],
    rows: records.map((row) => {
      const zone = row.shift.timezone;
      const approvalNote = row.isExcusedLate
        ? `\n${t("attendance.excusedLate")}`
        : row.lateApprovalStatus === "APPROVED"
          ? `\n${t("attendance.lateApproval", { status: t("approval.APPROVED") })}\n${t("attendance.approvalMismatch")}`
          : row.lateApprovalStatus
            ? `\n${t("attendance.lateApproval", { status: t(`approval.${row.lateApprovalStatus}`) })}`
            : "";
      const punch = (value: Date | null) =>
        value
          ? `${date(value, zone)}\n${new Intl.DateTimeFormat(locale, { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(value)}`
          : "-";
      return [
        date(row.attendanceDate),
        row.employee
          ? `${row.employee.user.name || row.employee.employeeCode}\n${row.employee.employeeCode}`
          : t("attendance.deleted"),
        `${row.office.name}\n${row.shift.name}\n${zone}`,
        punch(row.checkInAt),
        punch(row.checkOutAt),
        duration(row.workedMinutes),
        row.overtimeMinutes === null
          ? t("attendance.unknown")
          : duration(row.overtimeMinutes),
        number.format(row.lateMinutes),
        `${t(`status.${row.status}`)}${approvalNote}${row.derived ? `\n${t("attendance.scheduledDay")}` : ""}`,
        row.lateReason || "-",
      ];
    }),
    cellTextColors: records.map((row) => [
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      row.overtimeMinutes === null
        ? undefined
        : isCountedOvertime(row.overtimeMinutes)
          ? "#176B4A"
          : "#B42318",
    ]),
    footerNote:
      t("attendance.footer") +
      (unknown
        ? ` ${t("attendance.unknownOvertime", { count: unknown })}`
        : ""),
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
