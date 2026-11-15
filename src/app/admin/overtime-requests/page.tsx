import { Suspense } from "react";
import { connection } from "next/server";
import LoadingWorkspace from "@/app/loading";
import { OvertimeRequestsWorkspace } from "@/components/overtime-requests-workspace";
import { requirePageUser } from "@/lib/auth";

export default function Page() {
  return (
    <Suspense fallback={<LoadingWorkspace />}>
      <OvertimeRequestsPage />
    </Suspense>
  );
}

async function OvertimeRequestsPage() {
  await connection();
  await requirePageUser("SUPER_ADMIN");
  return <OvertimeRequestsWorkspace />;
}
