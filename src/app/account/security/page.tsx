import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { connection } from "next/server";
import WorkspaceLoading from "@/components/workspace-loading";
import { AppShell } from "@/components/app-shell";
import { AccountPasswordForm } from "@/components/auth/account-password-form";
import { PageHeader } from "@/components/ui";
import { requirePageUser } from "@/lib/auth";
import { isEmployeeRole } from "@/modules/auth/authorization";
import { StoreProvider } from "@/store/provider";

async function AccountSecurityContent() {
  await connection();
  const t = await getTranslations("auth");
  const user = await requirePageUser();
  return (
    <StoreProvider
      identity={{
        id: user.id,
        role: user.role,
        sessionId: user.sessionId,
        expires: user.sessionExpires,
      }}
    >
      <AppShell
        mode={isEmployeeRole(user.role) ? "employee" : "admin"}
        user={{
          id: user.id,
          profileSlug: user.profileSlug,
          name: user.name,
          email: user.email,
          role: user.role,
          image: user.image,
          hasEmployeeProfile: Boolean(user.employee),
        }}
      >
        <PageHeader
          eyebrow={t("yourAccount")}
          title={t("security")}
          description={t("securityDescription", { email: user.email })}
        />
        <AccountPasswordForm />
      </AppShell>
    </StoreProvider>
  );
}

export default function AccountSecurityPage() {
  return (
    <Suspense fallback={<WorkspaceLoading />}>
      <AccountSecurityContent />
    </Suspense>
  );
}
