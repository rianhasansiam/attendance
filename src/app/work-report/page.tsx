import { Suspense } from "react";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { WorkReportWorkspace } from "@/components/work-report-workspace";
import WorkspaceLoading from "@/components/workspace-loading";
import { FeatureMessages } from "@/i18n/feature-messages";
import { requireUser } from "@/lib/auth";
import { DomainError } from "@/lib/errors";
import { authorizeWorkReport } from "@/modules/work-report/permissions";
import { StoreProvider } from "@/store/provider";

export default function WorkReportPage() {
  return (
    <Suspense fallback={<WorkspaceLoading />}>
      <AuthorizedWorkReport />
    </Suspense>
  );
}
async function AuthorizedWorkReport() {
  await connection();
  const user = await workReportUser();
  return (
    <FeatureMessages namespaces={["workReport"]}>
      <StoreProvider
        identity={{
          id: user.id,
          role: user.role,
          sessionId: user.sessionId,
          expires: user.sessionExpires,
        }}
      >
        <AppShell
          mode={user.role === "SUPER_ADMIN" ? "admin" : "employee"}
          user={{
            id: user.id,
            profileSlug: user.profileSlug,
            name: user.name,
            email: user.email,
            role: user.role,
            image: user.image,
            hasEmployeeProfile: !!user.employee,
          }}
        >
          <WorkReportWorkspace />
        </AppShell>
      </StoreProvider>
    </FeatureMessages>
  );
}
async function workReportUser() {
  try {
    const user = await requireUser();
    authorizeWorkReport(user);
    return user;
  } catch (error) {
    if (error instanceof DomainError)
      redirect(error.status === 401 ? "/login" : "/forbidden");
    throw error;
  }
}
