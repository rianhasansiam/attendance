import { Suspense } from "react";
import { connection } from "next/server";
import LoadingWorkspace from "@/app/loading";
import { AdminReports } from "@/components/admin-workspace";
import { requirePageUser } from "@/lib/auth";

type PageProps = { searchParams: Promise<{ employeeId?: string }> };

export default function Page({ searchParams }: PageProps) {
  return (
    <Suspense fallback={<LoadingWorkspace />}>
      <AttendancePage searchParams={searchParams} />
    </Suspense>
  );
}

async function AttendancePage({ searchParams }: PageProps) {
  await connection();
  const [user, { employeeId }] = await Promise.all([
    requirePageUser("ADMIN"),
    searchParams,
  ]);
  return (
    <AdminReports
      attendance
      employeeId={employeeId || ""}
      canCorrectAttendance={user.role === "SUPER_ADMIN"}
    />
  );
}
