"use client";

import { useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/client/request";
import { ErrorNotice, Notice } from "@/components/ui";
import { errorMessage } from "@/store/api/errors";

const RESET_MESSAGE =
  "If an account exists for this email, password reset instructions have been sent.";

export function ForgotPasswordForm() {
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const values = new FormData(event.currentTarget);
    const email = String(values.get("email") || "")
      .trim()
      .toLowerCase();
    if (!email) return;
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      await api<{ message: string }>("/api/password/forgot", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setSent(true);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  if (sent) return <Notice>{RESET_MESSAGE}</Notice>;
  return (
    <form className="auth-form" onSubmit={submit} aria-busy={pending}>
      <ErrorNotice message={error} />
      <div className="field">
        <label htmlFor="reset-email">Email</label>
        <input
          id="reset-email"
          name="email"
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          disabled={pending}
        />
      </div>
      <button className="button full-width" type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send reset instructions"}
      </button>
    </form>
  );
}
