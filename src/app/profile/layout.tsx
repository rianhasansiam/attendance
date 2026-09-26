import type { Metadata } from "next";
import Link from "next/link";
import { CheckCheck } from "lucide-react";
import styles from "./profile.module.css";

export const metadata: Metadata = {
  title: "Public profile",
  description: "Meet the people at XHYD.",
};

export default function PublicProfileLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>
            <CheckCheck size={24} aria-hidden="true" />
          </span>
          <span>XHYD</span>
        </div>
        <Link href="/login" className="button secondary" prefetch={false}>
          Sign in
        </Link>
      </header>
      <main className={styles.main}>{children}</main>
      <footer className={styles.footer}>XHYD · Our people</footer>
    </div>
  );
}
