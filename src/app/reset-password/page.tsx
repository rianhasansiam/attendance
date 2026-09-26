import type { Metadata } from "next";
import Link from "next/link";
import { CheckCheck } from "lucide-react";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export const metadata: Metadata = {
  title: "Choose a new password",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function ResetPasswordPage() {
  return (
    <main className="login-page">
      <div className="login-card password-page-card">
        <span className="login-mark">
          <CheckCheck size={40} />
        </span>
        <h1>Choose a new password</h1>
        <p className="auth-help">
          Set an application password for XHYD. Never enter your Google password
          here.
        </p>
        <ResetPasswordForm />
        <Link className="auth-link auth-back-link" href="/login">
          Back to sign in
        </Link>
      </div>
    </main>
  );
}
