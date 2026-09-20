import { Suspense } from "react";
import { EmployeeProfile } from "@/components/employee-profile";
import { Loading } from "@/components/ui";
import { requirePageEmployee } from "@/lib/auth";
import { db } from "@/lib/db";

async function Profile() {
  const user = await requirePageEmployee();
  const employee = await db.employee.findUniqueOrThrow({
    where: { id: user.employee.id },
    select: {
      employeeCode: true,
      joinedAt: true,
      department: { select: { name: true } },
      office: { select: { name: true, timezone: true } },
    },
  });
  return <EmployeeProfile employee={employee} user={user} />;
}

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Profile />
    </Suspense>
  );
}
