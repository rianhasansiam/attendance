import { auth, signIn } from "@/auth";
import { redirect } from "next/navigation";
import { CheckCheck } from "lucide-react";
import { connection } from "next/server";
import { Suspense } from "react";
import LoadingWorkspace from "@/app/loading";

type Props = { searchParams: Promise<{ error?: string }> };
export default function Login(props: Props) {
  return (
    <Suspense fallback={<LoadingWorkspace />}>
      <LoginContent {...props} />
    </Suspense>
  );
}
async function LoginContent({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await connection();
  const session =
    process.env.DATABASE_URL && process.env.AUTH_SECRET ? await auth() : null;
  if (session?.user?.id)
    redirect(
      session.user.role === "EMPLOYEE"
        ? "/employee/dashboard"
        : "/admin/dashboard",
    );
  const { error } = await searchParams;
  return (
    <main className="login-page">
      <div className="login-card">
        <span className="login-mark">
          <CheckCheck size={40} />
        </span>
        <h1>
          BangBuy Attendance
          <br />
          System
        </h1>
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/" });
          }}
        >
          <button className="google-button" type="submit">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-1.99 3.02v2.51h3.23c1.89-1.74 2.98-4.3 2.98-7.36Z"
              />
              <path
                fill="#34A853"
                d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.23-2.51c-.9.6-2.05.97-3.39.97-2.61 0-4.83-1.76-5.62-4.13H3.04v2.59A10 10 0 0 0 12 22Z"
              />
              <path
                fill="#FBBC05"
                d="M6.38 13.92a6 6 0 0 1 0-3.84V7.49H3.04a10 10 0 0 0 0 9.02l3.34-2.59Z"
              />
              <path
                fill="#EA4335"
                d="M12 5.95c1.47 0 2.79.5 3.82 1.49l2.86-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.96 5.49l3.34 2.59C7.17 7.71 9.39 5.95 12 5.95Z"
              />
            </svg>
            Continue with Google
          </button>
        </form>
        {error && (
          <p className="login-error" role="alert">
            {error === "AccessDenied"
              ? "Your account is not authorized. Contact your administrator."
              : "Sign-in could not be completed. Please try again."}
          </p>
        )}
      </div>
    </main>
  );
}
