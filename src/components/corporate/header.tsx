"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight, LogIn, Menu, X } from "lucide-react";
import { navigation as navigationLinks } from "@/data/company";
import { useCorporateDialog } from "./interactions";
import styles from "./home.module.css";

const navigation = navigationLinks.map((item) => ({
  ...item,
  id: item.href.slice(1),
}));

function Wordmark({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <a
      href="#home"
      className={styles.wordmark}
      aria-label="XHYD home"
      onClick={onNavigate}
    >
      <span className={styles.logoPlate}>
        <Image
          src="/company_logo.jpeg"
          alt="XHYD"
          width={1082}
          height={205}
          sizes="126px"
      className={`${styles.wordmarkImage} m-auto`}
        />
      </span>
      <span className={styles.brandTagline}>XianHao Yida Technology Co. Ltd.</span>
    </a>
  );
}

export function CorporateHeader() {
  const headerRef = useRef<HTMLElement>(null);
  const [activeSection, setActiveSection] = useState<string>("home");
  const {
    dialogRef,
    triggerRef,
    isOpen,
    open,
    close,
    onClose,
    onBackdropClick,
  } = useCorporateDialog();

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;

    function updateScrolled() {
      header?.classList.toggle(styles.headerScrolled, window.scrollY > 16);
    }
    updateScrolled();
    window.addEventListener("scroll", updateScrolled, { passive: true });

    return () => window.removeEventListener("scroll", updateScrolled);
  }, []);

  useEffect(() => {
    if (!("IntersectionObserver" in window)) return;
    const visibleSections = new Map<string, IntersectionObserverEntry>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visibleSections.set(entry.target.id, entry);
          } else {
            visibleSections.delete(entry.target.id);
          }
        }
        const first = Array.from(visibleSections.values()).sort(
          (a, b) =>
            Math.abs(a.target.getBoundingClientRect().top) -
            Math.abs(b.target.getBoundingClientRect().top),
        )[0];
        if (first) setActiveSection(first.target.id);
      },
      { rootMargin: "-18% 0px -64% 0px", threshold: 0 },
    );

    for (const item of navigation) {
      const section = document.getElementById(item.id);
      if (section) observer.observe(section);
    }
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1100px)");
    const dialog = dialogRef.current;
    function closeOnDesktop() {
      if (desktop.matches && dialog?.open) dialog.close();
    }
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, [dialogRef]);

  function navigateTo(id: string) {
    setActiveSection(id);
    close();
  }

  return (
    <header ref={headerRef} className={styles.header}>
      <div className={styles.headerInner}>
        <Wordmark />
        <nav className={styles.desktopNav} aria-label="Main navigation">
          {navigation.map((item) => (
            <a
              key={item.id}
              href={item.href}
              className={`${styles.navLink} ${activeSection === item.id ? styles.navActive : ""}`}
              aria-current={activeSection === item.id ? "location" : undefined}
              onClick={() => setActiveSection(item.id)}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className={styles.headerActions}>
          <Link href="/login" prefetch={false} className={styles.headerLogin}>
            <LogIn size={16} aria-hidden="true" /> Login
          </Link>
          <a href="#contact" className={styles.headerCta}>
            Let’s Connect <ArrowUpRight size={15} aria-hidden="true" />
          </a>
          <button
            ref={triggerRef}
            type="button"
            className={styles.menuTrigger}
            aria-label="Open navigation"
            aria-haspopup="dialog"
            aria-expanded={isOpen}
            aria-controls="xhyd-mobile-navigation"
            onClick={open}
          >
            <Menu size={24} aria-hidden="true" />
          </button>
        </div>
      </div>
      <dialog
        ref={dialogRef}
        id="xhyd-mobile-navigation"
        className={styles.mobileDialog}
        aria-label="XHYD navigation"
        onClose={onClose}
        onClick={onBackdropClick}
      >
        <div className={styles.mobileDialogHeader}>
          <Wordmark onNavigate={() => navigateTo("home")} />
          <button
            type="button"
            className={styles.mobileClose}
            aria-label="Close navigation"
            onClick={close}
            autoFocus
          >
            <X size={24} aria-hidden="true" />
          </button>
        </div>
        <nav className={styles.mobileNav} aria-label="Mobile navigation">
          {navigation.map((item, index) => (
            <a
              key={item.id}
              href={item.href}
              className={`${styles.mobileNavLink} ${activeSection === item.id ? styles.navActive : ""}`}
              aria-current={activeSection === item.id ? "location" : undefined}
              onClick={() => navigateTo(item.id)}
            >
              <span aria-hidden="true">0{index + 1}</span>
              {item.label}
              <ArrowUpRight size={20} aria-hidden="true" />
            </a>
          ))}
        </nav>
        <div className={styles.mobileNavMeta}>
          <p>Rooted in China. Connected to the world.</p>
          <Link
            href="/login"
            prefetch={false}
            className={styles.mobileLogin}
            onClick={close}
          >
            <LogIn size={19} aria-hidden="true" /> Dashboard login
            <ArrowUpRight size={18} aria-hidden="true" />
          </Link>
          <a
            href="#contact"
            className={styles.mobileCta}
            onClick={() => navigateTo("contact")}
          >
            Let’s Connect <ArrowUpRight size={18} aria-hidden="true" />
          </a>
        </div>
      </dialog>
    </header>
  );
}
