import { z } from "zod";
import { api } from "@/lib/api";
import { requireEmployee } from "@/lib/auth";
import { db } from "@/lib/db";
import { sanitizeAttendance } from "@/modules/attendance/service";
import { attendanceDisplaySelect } from "@/modules/attendance/queries";
const filters = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    page: z.coerce.number().int().positive().max(10000).default(1),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: "Invalid date range",
  });
export function GET(request: Request) {
  return api(async () => {
    const actor = await requireEmployee();
    const query = filters.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const where = {
      employeeId: actor.employee.id,
      attendanceDate: {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      },
    };
    const [records, total] = await Promise.all([
      db.attendance.findMany({
        where,
        select: attendanceDisplaySelect,
        orderBy: { attendanceDate: "desc" },
        take: 50,
        skip: (query.page - 1) * 50,
      }),
      db.attendance.count({ where }),
    ]);
    return {
      records: records.map(sanitizeAttendance),
      total,
      page: query.page,
      pageSize: 50,
    };
  });
}
