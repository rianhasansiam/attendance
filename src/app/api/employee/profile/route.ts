import { api } from "@/lib/api";
import { requireEmployee } from "@/lib/auth";
import { db } from "@/lib/db";
import { employeeInclude } from "@/modules/employees/service";

export function GET() {
  return api(async () => {
    const user = await requireEmployee();
    return db.employee.findUniqueOrThrow({
      where: { id: user.employee.id },
      include: {
        ...employeeInclude,
        shifts: { include: { shift: true }, orderBy: { startDate: "desc" } },
      },
    });
  });
}
