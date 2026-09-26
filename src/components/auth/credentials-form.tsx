"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { ErrorNotice } from "@/components/ui";
import { PasswordField } from "./password-fields";

export function CredentialsForm() {
  const router = useRouter();
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const email = String(values.get("email") || "")
      .trim()
      .toLowerCase();
    const password = String(values.get("password") || "");
    if (!email || !password || password.length > 128) {
      setError("Invalid email or password.");
      return;
    }
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
        redirectTo: "/",
      });
      // Never expose provider errors or use an untrusted callback URL.
      if (!result?.ok || result.error) {
        setError("Invalid email or password.");
      } else {
        form.reset();
        router.replace("/");
        router.refresh();
      }
    } catch {
      setError("Sign-in could not be completed. Please try again.");
    } finally {
      const passwordInput = form.elements.namedItem("password");
      if (passwordInput instanceof HTMLInputElement) passwordInput.value = "";
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit} aria-busy={pending}>
      <ErrorNotice message={error} />
      <div className="field">
        <label htmlFor="login-email">Email</label>
        <input
          id="login-email"
          name="email"
          type="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          disabled={pending}
        />
      </div>
      <PasswordField
        name="password"
        label="Application password"
        autoComplete="current-password"
        disabled={pending}
        hint="Use the password you set for XHYD, never your Google password."
      />
      <button className="button full-width" type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
      <Link className="auth-link" href="/forgot-password">
        Forgot password?
      </Link>
    </form>
  );
}
