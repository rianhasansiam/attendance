import { FeatureMessages } from "@/i18n/feature-messages";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Suspense } from "react";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { CheckCheck } from "lucide-react";
import styles from "./profile.module.css";

export default function PublicProfileLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense fallback={null}>
      <PublicProfileLayoutContent>{children}</PublicProfileLayoutContent>
    </Suspense>
  );
}

async function PublicProfileLayoutContent({
  children,
}: {
  children: React.ReactNode;
}) {
  await connection();
  const t = await getTranslations("admin");
  return (
    <FeatureMessages namespaces={["employee"]}>
      <div className={styles.page}>
        <header className={styles.header}>
          <div className={styles.brand}>
            <span className={styles.brandMark}>
              <CheckCheck size={24} aria-hidden="true" />
            </span>
            <span>XHYD</span>
          </div>
          <LanguageSwitcher />
          <Link href="/login" className="button secondary" prefetch={false}>
            {t("publicProfile.signIn")}
          </Link>
        </header>
        <main className={styles.main}>{children}</main>
        <footer className={styles.footer}>{t("publicProfile.footer")}</footer>
      </div>
    </FeatureMessages>
  );
}
