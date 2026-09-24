import { api, readJson } from "@/lib/api";
import { requireEmployee } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { createLeave } from "@/modules/management/workflows";
import { leaveSchema, paginationSchema } from "@/modules/management/validation";

export function GET(request: Request) {
  return api(async () => {
    const user = await requireEmployee();
    const { page, pageSize } = paginationSchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const where = { employeeId: user.employee.id };
    const [items, total] = await Promise.all([
      db.leave.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: pageSize,
        skip: (page - 1) * pageSize,
      }),
      db.leave.count({ where }),
    ]);
    return { items, total, page, pageSize };
  });
}

export function POST(request: Request) {
  return api(async () => {
    assertSameOrigin(request);
    const user = await requireEmployee();
    await rateLimit(`leave:${user.id}`, 10, 60);
    return createLeave(user, await readJson(request, leaveSchema));
  });
}
