"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { api } from "@/lib/client/request";
import { ErrorNotice } from "@/components/ui";
import { errorMessage } from "@/store/api/errors";
import { useAppStore } from "@/store/hooks";
import { clearWorkspaceData } from "@/store/make-store";
import { workspaceClosed } from "@/store/features/workspace-ui/slice";
import {
  NewPasswordFields,
  PasswordField,
  validateNewPassword,
} from "./password-fields";

export function AccountPasswordForm() {
  const store = useAppStore();
  const submitting = useRef(false);
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void api<{ hasPassword: boolean }>("/api/account/password", {
      signal: controller.signal,
    })
      .then((result) => {
        setHasPassword(result.hasPassword);
        setError("");
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      });
    return () => controller.abort();
  }, [readAttempt]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || hasPassword === null) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const newPassword = String(values.get("newPassword") || "");
    const confirmPassword = String(values.get("confirmPassword") || "");
    const currentPassword = String(values.get("currentPassword") || "");
    const validation = validateNewPassword(newPassword, confirmPassword);
    if (validation) {
      setError(validation);
      return;
    }
    if (hasPassword && !currentPassword) {
      setError("Enter your current application password.");
      return;
    }
    submitting.current = true;
    setPending(true);
    setError("");
    let saved = false;
    try {
      await api<{ message: string }>("/api/account/password", {
        method: "POST",
        body: JSON.stringify({
          ...(hasPassword ? { currentPassword } : {}),
          newPassword,
          confirmPassword,
        }),
      });
      saved = true;
      form.reset();
      store.dispatch(workspaceClosed("signed-out"));
      clearWorkspaceData(store);
      // The server has revoked every session; finish the supported Auth.js
      // sign-out ceremony to clear this browser's cookie and notify other tabs.
      await signOut({ redirectTo: "/login" });
    } catch (error) {
      if (saved) window.location.replace("/login");
      else setError(errorMessage(error));
    } finally {
      if (!saved) {
        submitting.current = false;
        setPending(false);
      }
    }
  }

  if (hasPassword === null)
    return (
      <div className="panel account-security-card">
        {error ? (
          <>
            <ErrorNotice message={error} />
            <button
              className="button secondary"
              onClick={() => {
                setError("");
                setReadAttempt((attempt) => attempt + 1);
              }}
            >
              Try again
            </button>
          </>
        ) : (
          <p className="muted" role="status">
            Loading password settings…
          </p>
        )}
      </div>
    );

  return (
    <section
      className="panel account-security-card"
      aria-labelledby="password-title"
    >
      <h2 id="password-title">
        {hasPassword ? "Change password" : "Set password"}
      </h2>
      <p className="auth-help">
        {hasPassword
          ? "You can sign in with Google or your application password."
          : "Add an application password to sign in with email. Google sign-in will remain available."}{" "}
        Use a separate password for XHYD, never your Google password.
      </p>
      <form className="auth-form" onSubmit={submit} aria-busy={pending}>
        <ErrorNotice message={error} />
        {hasPassword && (
          <PasswordField
            name="currentPassword"
            label="Current application password"
            autoComplete="current-password"
            disabled={pending}
          />
        )}
        <NewPasswordFields disabled={pending} />
        <p className="auth-help">
          Saving your password signs you out on all devices. Sign in again
          afterward.
        </p>
        <button className="button" type="submit" disabled={pending}>
          {pending
            ? "Saving…"
            : hasPassword
              ? "Change password"
              : "Set password"}
        </button>
        {hasPassword && (
          <Link className="auth-link" href="/forgot-password">
            Forgot your current password?
          </Link>
        )}
      </form>
    </section>
  );
}
