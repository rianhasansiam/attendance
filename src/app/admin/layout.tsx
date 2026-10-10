import { FeatureMessages } from "@/i18n/feature-messages";
import { requirePageUser } from "@/lib/auth";
import { StoreProvider } from "@/store/provider";
import { AppShell } from "@/components/app-shell";
import { Suspense } from "react";
import { connection } from "next/server";
import WorkspaceLoading from "@/components/workspace-loading";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense fallback={<WorkspaceLoading />}>
      <AuthenticatedAdminLayout>{children}</AuthenticatedAdminLayout>
    </Suspense>
  );
}
async function AuthenticatedAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await connection();
  const user = await requirePageUser("ADMIN");
  return (
    <FeatureMessages namespaces={["admin", "employee", "expenses"]}>
      <StoreProvider
        identity={{
          id: user.id,
          role: user.role,
          sessionId: user.sessionId,
          expires: user.sessionExpires,
        }}
      >
        <AppShell
          mode="admin"
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
          {children}
        </AppShell>
      </StoreProvider>
    </FeatureMessages>
  );
}
