import { getTranslations } from "next-intl/server";
import { LanguageSwitcher } from "@/components/language-switcher";
import { auth, signIn } from "@/auth";
import { redirect } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import localFont from "next/font/local";
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarCheck2,
  FileText,
  ShieldCheck,
  Users,
} from "lucide-react";
import { connection } from "next/server";
import { Suspense } from "react";
import LoadingWorkspace from "@/app/loading";
import { isEmployeeRole } from "@/modules/auth/authorization";
import { ErrorNotice } from "@/components/ui";
import { CredentialsForm } from "@/components/auth/credentials-form";
import styles from "./login.module.css";

const manrope = localFont({
  src: "../../assets/fonts/manrope/Manrope-Variable.ttf",
  weight: "200 800",
  display: "swap",
  variable: "--login-font",
  fallback: ["Arial", "Helvetica", "sans-serif"],
});

type Props = { searchParams: Promise<{ error?: string }> };
export default function Login(props: Props) {
  return (
    <Suspense fallback={<LoadingWorkspace />}>
      <LoginContent {...props} />
    </Suspense>
  );
}
async function LoginContent({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await connection();
  const t = await getTranslations("auth");
  const session =
    process.env.DATABASE_URL && process.env.AUTH_SECRET ? await auth() : null;
  if (session?.user?.id)
    redirect(
      isEmployeeRole(session.user.role)
        ? "/employee/dashboard"
        : "/admin/dashboard",
    );
  const { error } = await searchParams;
  return (
    <main className={`${styles.page} ${manrope.variable}`}>
      <header className={styles.header}>
        <Link
          href="/"
          className={styles.brand}
          aria-label="XHYD"
          prefetch={false}
        >
          <Image
            src="/company_logo.jpeg"
            alt="XHYD"
            width={1082}
            height={205}
            sizes="132px"
          />
        </Link>
        <div className={styles.headerActions}>
          <Link href="/" className={styles.backLink} prefetch={false}>
            <ArrowLeft size={15} aria-hidden="true" />
            {t("loginUi.backHome")}
          </Link>
          <LanguageSwitcher />
        </div>
      </header>
      <div className={styles.layout}>
        <aside
          className={styles.visual}
          aria-label={t("loginUi.visualEyebrow")}
        >
          <Image
            src="/images/xhyd/architecture.webp"
            alt=""
            fill
            sizes="(max-width: 900px) 0px, 50vw"
          />
          <div className={styles.visualShade} aria-hidden="true" />
          <div className={styles.visualContent}>
            <p className={styles.visualEyebrow}>
              <span aria-hidden="true" />
              {t("loginUi.visualEyebrow")}
            </p>
            <div className={styles.visualNarrative}>
              <p className={styles.visualTitle}>
                {t("loginUi.visualTitleFirst")}
                <br />
                <span>{t("loginUi.visualTitleSecond")}</span>
              </p>
              <p className={styles.visualDescription}>
                {t("loginUi.visualDescription")}
              </p>
              <div className={styles.visualTags}>
                <span>
                  <CalendarCheck2 size={16} aria-hidden="true" />
                  {t("loginUi.attendance")}
                </span>
                <span>
                  <FileText size={16} aria-hidden="true" />
                  {t("loginUi.records")}
                </span>
                <span>
                  <Users size={16} aria-hidden="true" />
                  {t("loginUi.team")}
                </span>
              </div>
            </div>
            <div className={styles.visualFooter}>
              <span>{t("loginUi.visualCaption")}</span>
              <ArrowUpRight size={20} aria-hidden="true" />
            </div>
          </div>
        </aside>
        <section className={styles.formPanel} aria-labelledby="login-title">
          <div className={styles.formContent}>
            <div className={styles.formIntro}>
              <p className={styles.formEyebrow}>
                <span aria-hidden="true" />
                {t("loginUi.eyebrow")}
              </p>
              <h1 id="login-title">{t("loginUi.welcome")}</h1>
              <p>{t("loginUi.introduction")}</p>
            </div>
            <form
              action={async () => {
                "use server";
                await signIn("google", { redirectTo: "/workspace" });
              }}
            >
              <button className={styles.googleButton} type="submit">
                <svg
                  viewBox="0 0 24 24"
                  width="20"
                  height="20"
                  aria-hidden="true"
                >
                  <path
                    fill="#4285F4"
                    d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-1.99 3.02v2.51h3.23c1.89-1.74 2.98-4.3 2.98-7.36Z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.23-2.51c-.9.6-2.05.97-3.39.97-2.61 0-4.83-1.76-5.62-4.13H3.04v2.59A10 10 0 0 0 12 22Z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M6.38 13.92a6 6 0 0 1 0-3.84V7.49H3.04a10 10 0 0 0 0 9.02l3.34-2.59Z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 5.95c1.47 0 2.79.5 3.82 1.49l2.86-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.96 5.49l3.34 2.59C7.17 7.71 9.39 5.95 12 5.95Z"
                  />
                </svg>
                {t("google")}
              </button>
            </form>
            {error && (
              <ErrorNotice
                message={
                  error === "AccessDenied"
                    ? t("unauthorized")
                    : t("signInFailed")
                }
              />
            )}
            <div className={`auth-divider ${styles.divider}`}>
              <span>{t("or")}</span>
            </div>
            <CredentialsForm />
            <p className={styles.accessNote}>
              <ShieldCheck size={16} aria-hidden="true" />
              <span>{t("loginUi.accessNote")}</span>
            </p>
          </div>
        </section>
      </div>
      <footer className={styles.footer}>
        <span>XHYD</span>
        <p>{t("loginUi.footer")}</p>
      </footer>
    </main>
  );
}
