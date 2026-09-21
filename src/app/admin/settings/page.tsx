import { Suspense } from "react";
import { connection } from "next/server";
import LoadingWorkspace from "@/app/loading";
import { AdminSettings } from "@/components/admin-workspace";
import { requirePageUser } from "@/lib/auth";

export default function Page() {
  return (
    <Suspense fallback={<LoadingWorkspace />}>
      <SuperAdminSettings />
    </Suspense>
  );
}

async function SuperAdminSettings() {
  await connection();
  await requirePageUser("SUPER_ADMIN");
  return <AdminSettings />;
}
