import { Suspense } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
export default function Forbidden() {
  return (
    <Suspense fallback={null}>
      <ForbiddenContent />
    </Suspense>
  );
}
function ForbiddenContent() {
  const t = useTranslations("common");
  return (
    <main className="login-page">
      <section className="login-card">
        <span className="login-mark">
          <ShieldCheck size={38} />
        </span>
        <h1>{t("forbiddenTitle")}</h1>
        <p className="muted" style={{ marginBottom: 25 }}>
          {t("forbiddenDescription")}
        </p>
        <Link href="/" className="button">
          {t("return")}
        </Link>
      </section>
    </main>
  );
}
