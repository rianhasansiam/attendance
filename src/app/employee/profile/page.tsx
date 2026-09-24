import { Suspense } from "react";
import { EmployeeProfile } from "@/components/employee-profile";
import { ProfileRefresh } from "@/components/profile-refresh";
import { Loading } from "@/components/ui";
import { requirePageEmployee } from "@/lib/auth";
import { getOwnEmployeeProfile } from "@/modules/employees/service";

async function Profile() {
  const user = await requirePageEmployee();
  const employee = await getOwnEmployeeProfile(user);
  return (
    <>
      <ProfileRefresh />
      <EmployeeProfile employee={employee} user={user} />
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Profile />
    </Suspense>
  );
}
