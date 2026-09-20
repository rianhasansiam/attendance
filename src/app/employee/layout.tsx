import { requirePageEmployee } from "@/lib/auth";
import { signOut } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { Suspense } from "react";
import { connection } from "next/server";
import LoadingWorkspace from "@/app/loading";

export default function EmployeeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense fallback={<LoadingWorkspace />}>
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
    <AppShell
      mode="employee"
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
