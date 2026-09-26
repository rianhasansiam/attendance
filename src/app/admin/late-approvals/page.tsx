import { Suspense } from "react";
import { connection } from "next/server";
import LoadingWorkspace from "@/app/loading";
import { LateApprovalsWorkspace } from "@/components/late-approvals-workspace";
import { requirePageUser } from "@/lib/auth";

export default function Page() {
  return (
    <Suspense fallback={<LoadingWorkspace />}>
      <LateApprovalsPage />
    </Suspense>
  );
}

async function LateApprovalsPage() {
  await connection();
  await requirePageUser("ADMIN");
  return <LateApprovalsWorkspace />;
}
