"use client";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { isLocale } from "@/i18n/config";
export function LanguageSwitcher() {
  const locale = useLocale();
  const t = useTranslations("common");
  const router = useRouter();
  const id = useId();
  const [saving, setSaving] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);
  async function change(value: string) {
    if (!isLocale(value) || value === locale || saving || refreshing) return;
    setSaving(true);
    setFailed(false);
    try {
      const response = await fetch("/api/locale", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: value }),
      });
      if (!response.ok) throw new Error("locale");
      startTransition(() => router.refresh());
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="language-switcher">
      <label className="sr-only" htmlFor={id}>
        {t("language")}
      </label>
      <select
        id={id}
        aria-label={t("language")}
        value={locale}
        disabled={saving || refreshing}
        onChange={(event) => void change(event.target.value)}
      >
        <option value="en" lang="en">
          English
        </option>
        <option value="zh-CN" lang="zh-CN">
          简体中文
        </option>
      </select>
      {failed && <small role="alert">{t("languageFailed")}</small>}
    </div>
  );
}
