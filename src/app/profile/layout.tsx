import { FeatureMessages } from "@/i18n/feature-messages";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Suspense } from "react";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import Image from "next/image";
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
            <Image
              className={styles.brandLogo}
              src="/company_logo.jpeg"
              alt="XHYD"
              width={1082}
              height={205}
              sizes="(max-width: 540px) 148px, 172px"
            />
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
