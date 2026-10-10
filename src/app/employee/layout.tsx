import { FeatureMessages } from "@/i18n/feature-messages";
import { requirePageEmployee } from "@/lib/auth";
import { StoreProvider } from "@/store/provider";
import { AppShell } from "@/components/app-shell";
import { Suspense } from "react";
import { connection } from "next/server";
import WorkspaceLoading from "@/components/workspace-loading";

export default function EmployeeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense fallback={<WorkspaceLoading />}>
      <AuthenticatedEmployeeLayout>{children}</AuthenticatedEmployeeLayout>
    </Suspense>
  );
}
async function AuthenticatedEmployeeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await connection();
  const user = await requirePageEmployee();
  return (
    <FeatureMessages namespaces={["employee", "expenses"]}>
      <StoreProvider
        identity={{
          id: user.id,
          role: user.role,
          sessionId: user.sessionId,
          expires: user.sessionExpires,
        }}
      >
        <AppShell
          mode="employee"
          user={{
            id: user.id,
            profileSlug: user.profileSlug,
            name: user.name,
            email: user.email,
            role: user.role,
            image: user.image,
          }}
        >
          {children}
        </AppShell>
      </StoreProvider>
    </FeatureMessages>
  );
}
