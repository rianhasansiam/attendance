import { requirePageUser } from "@/lib/auth";
import { signOut } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { Suspense } from "react";
import { connection } from "next/server";
import LoadingWorkspace from "@/app/loading";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense fallback={<LoadingWorkspace />}>
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
    <AppShell
      mode="admin"
      user={{
        name: user.name,
        email: user.email,
        role: user.role,
        image: user.image,
      }}
      signOutAction={async () => {
        "use server";
        await signOut({ redirectTo: "/login" });
      }}
    >
      {children}
    </AppShell>
  );
}
