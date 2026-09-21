import { Suspense } from "react";
import { connection } from "next/server";
import LoadingWorkspace from "@/app/loading";
import { AdminResource } from "@/components/resource-workspace";
import { requirePageUser } from "@/lib/auth";

export default function Page() {
  return (
    <Suspense fallback={<LoadingWorkspace />}>
      <SuperAdminUsers />
    </Suspense>
  );
}

async function SuperAdminUsers() {
  await connection();
  await requirePageUser("SUPER_ADMIN");
  return <AdminResource resource="users" />;
}
