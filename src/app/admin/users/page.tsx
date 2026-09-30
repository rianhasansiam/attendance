import { Suspense } from "react";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import LoadingWorkspace from "@/app/loading";
import { requirePageUser } from "@/lib/auth";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<LoadingWorkspace />}>
      <UsersRedirect searchParams={searchParams} />
    </Suspense>
  );
}

async function UsersRedirect({ searchParams }: { searchParams: SearchParams }) {
  await connection();
  await requirePageUser("ADMIN");
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ["q", "page"]) {
    const value = params[key];
    if (typeof value === "string") query.set(key, value);
  }
  return redirect(`/admin/employees${query.size ? `?${query}` : ""}`);
}
