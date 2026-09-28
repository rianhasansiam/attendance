"use client";
import { useTranslations } from "next-intl";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { signOut } from "next-auth/react";
import { api } from "@/lib/client/request";
import { ErrorNotice } from "@/components/ui";
import { useErrorMessage } from "@/i18n/errors";
import { useAppStore } from "@/store/hooks";
import { clearWorkspaceData } from "@/store/make-store";
import { workspaceClosed } from "@/store/features/workspace-ui/slice";
import {
  NewPasswordFields,
  PasswordField,
  validateNewPassword,
} from "./password-fields";

export function AccountPasswordForm() {
  const t = useTranslations("auth");
  const common = useTranslations("common");
  const errorMessage = useErrorMessage();
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
  }, [readAttempt, errorMessage]);

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
      setError(t("enterCurrentPassword"));
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
              {common("retry")}
            </button>
          </>
        ) : (
          <p className="muted" role="status">
            {t("loadingPassword")}
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
        {hasPassword ? t("changePassword") : t("setPassword")}
      </h2>
      <p className="auth-help">
        {hasPassword ? t("hasPasswordHelp") : t("setPasswordHelp")}{" "}
        {t("separatePassword")}
      </p>
      <form className="auth-form" onSubmit={submit} aria-busy={pending}>
        <ErrorNotice message={error} />
        {hasPassword && (
          <PasswordField
            name="currentPassword"
            label={t("currentPassword")}
            autoComplete="current-password"
            disabled={pending}
          />
        )}
        <NewPasswordFields disabled={pending} />
        <p className="auth-help">{t("passwordSignOut")}</p>
        <button className="button" type="submit" disabled={pending}>
          {pending
            ? t("saving")
            : hasPassword
              ? t("changePassword")
              : t("setPassword")}
        </button>
      </form>
    </section>
  );
}
