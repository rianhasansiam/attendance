import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import LoadingWorkspace from "./loading";

export default function Home() {
  return (
    <Suspense fallback={<LoadingWorkspace />}>
      <HomeRedirect />
    </Suspense>
  );
}
async function HomeRedirect() {
  await connection();
  const session =
    process.env.DATABASE_URL && process.env.AUTH_SECRET ? await auth() : null;
  return redirect(
    !session?.user?.id
      ? "/login"
      : session.user.role === "EMPLOYEE"
        ? "/employee/dashboard"
        : "/admin/dashboard",
  );
}
