import type {
  AttendanceRecord,
  EmployeeDay,
} from "@/store/features/attendance/contracts";

export type AttendanceIntent = {
  action: "CHECK_IN" | "CHECK_OUT";
  employeeId: string;
  before: AttendanceRecord | null;
  knownArrivals: string[];
  observedServerTime: string;
};

export function attendanceIntent(
  action: AttendanceIntent["action"],
  day: EmployeeDay,
): AttendanceIntent {
  return {
    action,
    employeeId: day.employee.id,
    before: day.today,
    knownArrivals: [day.today, ...day.recent]
      .filter((record) => record?.id && record.checkInAt)
      .map((record) => `${record!.id}:${record!.checkInAt}`),
    observedServerTime: day.serverTime,
  };
}

// A successful GET alone does not prove an uncertain POST succeeded. Match the
// intended transition, including the original record for an overnight checkout.
export function recoveredAttendance(
  day: EmployeeDay,
  intent: AttendanceIntent,
): AttendanceRecord | undefined {
  if (day.employee.id !== intent.employeeId) return;
  return (
    [day.today, ...day.recent].find((record) => {
      if (!record?.id || !record.checkInAt) return false;
      if (intent.action === "CHECK_OUT") {
        return (
          !!intent.before?.checkInAt &&
          !intent.before.checkOutAt &&
          record.id === intent.before?.id &&
          record.attendanceDate === intent.before.attendanceDate &&
          record.checkInAt === intent.before.checkInAt &&
          !!record.checkOutAt &&
          Date.parse(record.checkOutAt) >=
            Date.parse(intent.observedServerTime) &&
          Date.parse(record.checkOutAt) >= Date.parse(record.checkInAt)
        );
      }
      return (
        !intent.knownArrivals.includes(`${record.id}:${record.checkInAt}`) &&
        Date.parse(record.checkInAt) >= Date.parse(intent.observedServerTime)
      );
    }) ?? undefined
  );
}
