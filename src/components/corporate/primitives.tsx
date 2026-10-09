import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import styles from "./home.module.css";

export function Container({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`${styles.container} ${className}`}>{children}</div>;
}

export function Eyebrow({
  children,
  light = false,
}: {
  children: ReactNode;
  light?: boolean;
}) {
  return (
    <p className={`${styles.eyebrow} ${light ? styles.eyebrowLight : ""}`}>
      <span aria-hidden="true" />
      {children}
    </p>
  );
}

export function ActionLink({
  children,
  href,
  variant = "primary",
  className = "",
}: {
  children: ReactNode;
  href: string;
  variant?: "primary" | "outline" | "text" | "dark";
  className?: string;
}) {
  return (
    <a
      href={href}
      className={`${styles.actionLink} ${styles[`${variant}Action`]} ${className}`}
    >
      {children}
      <ArrowUpRight size={18} strokeWidth={1.7} aria-hidden="true" />
    </a>
  );
}
