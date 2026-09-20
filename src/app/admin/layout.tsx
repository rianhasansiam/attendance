import { requirePageUser } from "@/lib/auth";
import { signOut } from "@/auth";
import { AppShell } from "@/components/app-shell";
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
