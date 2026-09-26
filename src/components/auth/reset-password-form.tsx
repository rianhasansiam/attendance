"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { api } from "@/lib/client/request";
import { ErrorNotice, Notice } from "@/components/ui";
import { errorMessage } from "@/store/api/errors";
import { NewPasswordFields, validateNewPassword } from "./password-fields";

export function ResetPasswordForm() {
  const token = useRef("");
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // Fragments are not sent to the server or in the Referer header. Keep the
    // secret only in this component, then remove it from the visible history.
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    if (!token.current) token.current = fragment.get("token") || "";
    if (window.location.hash || window.location.search)
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname,
      );
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || complete) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const newPassword = String(values.get("newPassword") || "");
    const confirmPassword = String(values.get("confirmPassword") || "");
    if (!token.current) {
      setError("This reset link is invalid or expired. Request a new link.");
      return;
    }
    const validation = validateNewPassword(newPassword, confirmPassword);
    if (validation) {
      setError(validation);
      return;
    }
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      await api<{ message: string }>("/api/password/reset", {
        method: "POST",
        body: JSON.stringify({
          token: token.current,
          newPassword,
          confirmPassword,
        }),
      });
      token.current = "";
      form.reset();
      setComplete(true);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  if (complete)
    return (
      <Notice>
        Your application password has been updated. All sessions have been
        signed out. Sign in with your new password or Google.
      </Notice>
    );
  return (
    <form className="auth-form" onSubmit={submit} aria-busy={pending}>
      <ErrorNotice message={error} />
      <NewPasswordFields disabled={pending} />
      <p className="auth-help">
        Updating your password signs you out on all devices.
      </p>
      <button className="button full-width" type="submit" disabled={pending}>
        {pending ? "Updating…" : "Update password"}
      </button>
      <Link className="auth-link" href="/forgot-password">
        Request a new reset link
      </Link>
    </form>
  );
}
