import { AdminReports } from "@/components/admin-workspace";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ employeeId?: string }>;
}) {
  const { employeeId } = await searchParams;
  return <AdminReports attendance employeeId={employeeId || ""} />;
}
