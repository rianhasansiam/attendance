import { auth } from "@/auth";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import LoadingWorkspace from "@/app/loading";
import { isEmployeeRole } from "@/modules/auth/authorization";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function Workspace() {
  return (
    <Suspense fallback={<LoadingWorkspace />}>
      <WorkspaceRedirect />
    </Suspense>
  );
}

async function WorkspaceRedirect() {
  await connection();
  const session =
    process.env.DATABASE_URL && process.env.AUTH_SECRET ? await auth() : null;
  return redirect(
    !session?.user?.id
      ? "/login"
      : isEmployeeRole(session.user.role)
        ? "/employee/dashboard"
        : "/admin/dashboard",
  );
}
