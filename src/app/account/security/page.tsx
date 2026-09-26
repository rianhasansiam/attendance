import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import LoadingWorkspace from "@/app/loading";
import { AppShell } from "@/components/app-shell";
import { AccountPasswordForm } from "@/components/auth/account-password-form";
import { PageHeader } from "@/components/ui";
import { requirePageUser } from "@/lib/auth";
import { isEmployeeRole } from "@/modules/auth/authorization";
import { StoreProvider } from "@/store/provider";

export const metadata: Metadata = { title: "Account security" };

async function AccountSecurityContent() {
  await connection();
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
        }}
      >
        <PageHeader
          eyebrow="Your account"
          title="Account security"
          description={`Manage the application password for ${user.email}.`}
        />
        <AccountPasswordForm />
      </AppShell>
    </StoreProvider>
  );
}

export default function AccountSecurityPage() {
  return (
    <Suspense fallback={<LoadingWorkspace />}>
      <AccountSecurityContent />
    </Suspense>
  );
}
