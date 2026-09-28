"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";

export const PASSWORD_HINT =
  "Use 12–128 characters. Long passphrases are welcome.";

export function validateNewPassword(password: string, confirmation: string) {
  if (password.length < 12 || password.length > 128)
    return "Use a password between 12 and 128 characters.";
  if (password !== confirmation) return "The passwords do not match.";
  return "";
}

export function PasswordField({
  name,
  label,
  autoComplete,
  disabled = false,
  hint,
  minLength,
  maxLength,
}: {
  name: string;
  label: string;
  autoComplete: "current-password" | "new-password";
  disabled?: boolean;
  hint?: string;
  minLength?: number;
  maxLength?: number;
}) {
  const t = useTranslations("auth");
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="password-input">
        <input
          id={id}
          name={name}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          autoCapitalize="none"
          spellCheck={false}
          required
          minLength={minLength}
          maxLength={maxLength}
          disabled={disabled}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        <button
          type="button"
          className="password-toggle"
          aria-label={t(visible ? "hidePassword" : "showPassword", {
            label: label.toLowerCase(),
          })}
          aria-pressed={visible}
          aria-controls={id}
          disabled={disabled}
          onClick={() => setVisible(!visible)}
        >
          {visible ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      </div>
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}

export function NewPasswordFields({ disabled }: { disabled: boolean }) {
  const t = useTranslations("auth");
  return (
    <>
      <PasswordField
        name="newPassword"
        label={t("newPassword")}
        autoComplete="new-password"
        disabled={disabled}
        hint={t("longPasswordHint")}
      />
      <PasswordField
        name="confirmPassword"
        label={t("confirmPassword")}
        autoComplete="new-password"
        disabled={disabled}
      />
    </>
  );
}
