import { Suspense } from "react";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { OfficeWorkWorkspace } from "@/components/office-work-workspace";
import WorkspaceLoading from "@/components/workspace-loading";
import { FeatureMessages } from "@/i18n/feature-messages";
import { requireUser } from "@/lib/auth";
import { DomainError } from "@/lib/errors";
import { authorizeOfficeWork } from "@/modules/office-work/permissions";
import { StoreProvider } from "@/store/provider";

export default function OfficeWorkPage() {
  return (
    <Suspense fallback={<WorkspaceLoading />}>
      <AuthorizedOfficeWork />
    </Suspense>
  );
}

async function AuthorizedOfficeWork() {
  await connection();
  const user = await officeWorkUser();
  return (
    <FeatureMessages namespaces={["officeWork"]}>
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
          <OfficeWorkWorkspace
            role={user.role as "SUPER_ADMIN" | "MANAGE_DRIVER" | "EMPLOYEE"}
          />
        </AppShell>
      </StoreProvider>
    </FeatureMessages>
  );
}

async function officeWorkUser() {
  try {
    const user = await requireUser();
    authorizeOfficeWork(user);
    return user;
  } catch (error) {
    if (error instanceof DomainError)
      redirect(error.status === 401 ? "/login" : "/forbidden");
    throw error;
  }
}
