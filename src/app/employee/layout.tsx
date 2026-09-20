import { requirePageEmployee } from "@/lib/auth";
import { signOut } from "@/auth";
import { AppShell } from "@/components/app-shell";
export default async function EmployeeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
