import { Suspense } from "react";
import { connection } from "next/server";
import LoadingWorkspace from "@/app/loading";
import { DriveCostWorkspace } from "@/components/drive-cost-workspace";
import { requirePageUser } from "@/lib/auth";

export default function Page() {
  return (
    <Suspense fallback={<LoadingWorkspace />}>
      <AuthorizedDriveCosts />
    </Suspense>
  );
}

async function AuthorizedDriveCosts() {
  await connection();
  const user = await requirePageUser("MANAGE_DRIVER");
  return (
    <DriveCostWorkspace canEditPaymentStatus={user.role === "SUPER_ADMIN"} />
  );
}
