import { AdminSettings } from "@/components/admin-workspace";
import { requirePageUser } from "@/lib/auth";
export default async function Page() {
  await requirePageUser("SUPER_ADMIN");
  return <AdminSettings />;
}
