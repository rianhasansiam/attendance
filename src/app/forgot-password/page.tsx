import type { Metadata } from "next";
import Link from "next/link";
import { CheckCheck } from "lucide-react";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

export const metadata: Metadata = {
  title: "Reset password",
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <main className="login-page">
      <div className="login-card password-page-card">
        <span className="login-mark">
          <CheckCheck size={40} />
        </span>
        <h1>Reset your password</h1>
        <p className="auth-help">
          Enter your account email to set or reset your XHYD application
          password.
        </p>
        <ForgotPasswordForm />
        <Link className="auth-link auth-back-link" href="/login">
          Back to sign in
        </Link>
      </div>
    </main>
  );
}
