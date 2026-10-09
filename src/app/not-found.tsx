import { Suspense } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
export default function NotFound() {
  return (
    <Suspense fallback={null}>
      <NotFoundContent />
    </Suspense>
  );
}
function NotFoundContent() {
  const t = useTranslations("common");
  return (
    <main className="login-page">
      <section className="login-card">
        <p className="eyebrow">{t("notFoundEyebrow")}</p>
        <h1>{t("notFoundTitle")}</h1>
        <p className="muted" style={{ marginBottom: 25 }}>
          {t("notFoundDescription")}
        </p>
        <Link href="/workspace" className="button">
          {t("back")}
        </Link>
      </section>
    </main>
  );
}
