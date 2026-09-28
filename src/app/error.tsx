"use client";
import { useTranslations } from "next-intl";
import { AlertCircle } from "lucide-react";
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("common");
  return (
    <main className="login-page">
      <section className="login-card">
        <span className="login-mark">
          <AlertCircle size={36} />
        </span>
        <h1>{t("errorTitle")}</h1>
        <p className="muted" style={{ marginBottom: 25 }}>
          {t("errorDescription")}
        </p>
        <button className="button" onClick={reset}>
          {t("retry")}
        </button>
      </section>
    </main>
  );
}
