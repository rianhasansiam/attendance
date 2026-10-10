import { Suspense } from "react";
import { connection } from "next/server";
import LoadingWorkspace from "@/app/loading";
import { SalaryWorkspace } from "@/components/salary-workspace";
import { requirePageUser } from "@/lib/auth";

export default function Page() {
  return (
    <Suspense fallback={<LoadingWorkspace />}>
      <AuthorizedSalaryCalculator />
    </Suspense>
  );
}

async function AuthorizedSalaryCalculator() {
  await connection();
  await requirePageUser("SUPER_ADMIN");
  return <SalaryWorkspace />;
}
