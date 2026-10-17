import { Suspense } from "react";
import { connection } from "next/server";
import LoadingWorkspace from "@/app/loading";
import { CompanyMoneyWorkspace } from "@/components/company-money-workspace";
import { requirePageUser } from "@/lib/auth";

export default function Page() {
  return (
    <Suspense fallback={<LoadingWorkspace />}>
      <AuthorizedCompanyMoney />
    </Suspense>
  );
}

async function AuthorizedCompanyMoney() {
  await connection();
  const user = await requirePageUser("ADMIN");
  return <CompanyMoneyWorkspace canManage={user.role === "SUPER_ADMIN"} />;
}
