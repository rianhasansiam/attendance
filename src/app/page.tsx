import { auth } from "@/auth";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
export default async function Home() {
  const session =
    process.env.DATABASE_URL && process.env.AUTH_SECRET ? await auth() : null;
  redirect(
    !session?.user?.id
      ? "/login"
      : session.user.role === "EMPLOYEE"
        ? "/employee/dashboard"
        : "/admin/dashboard",
  );
}
