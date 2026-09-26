import { Suspense } from "react";
import { connection } from "next/server";
import LoadingWorkspace from "@/app/loading";
import { AdminResource } from "@/components/resource-workspace";
import { requirePageUser } from "@/lib/auth";

export default function Page() {
  return (
    <Suspense fallback={<LoadingWorkspace />}>
      <EmployeesPage />
    </Suspense>
  );
}

async function EmployeesPage() {
  await connection();
  const user = await requirePageUser("ADMIN");
  return (
    <AdminResource
      resource="employees"
      canCreateEmployees={user.role === "SUPER_ADMIN"}
      canDeleteEmployees={user.role === "SUPER_ADMIN"}
      canEditPublicProfiles={user.role === "SUPER_ADMIN"}
    />
  );
}
