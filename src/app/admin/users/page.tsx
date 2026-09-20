import { AdminResource } from "@/components/resource-workspace";
import { requirePageUser } from "@/lib/auth";
export default async function Page() {
  await requirePageUser("SUPER_ADMIN");
  return <AdminResource resource="users" />;
}
