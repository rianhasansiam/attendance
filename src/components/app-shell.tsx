"use client";

import { useTranslations } from "next-intl";
import { LanguageSwitcher } from "@/components/language-switcher";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { useAppStore } from "@/store/hooks";
import { clearWorkspaceData } from "@/store/make-store";
import { workspaceClosed } from "@/store/features/workspace-ui/slice";
import { canManageDailyExpenses } from "@/modules/daily-expenses/permissions";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
  Building2,
  CalendarCheck2,
  CalendarDays,
  CarFront,
  ChartNoAxesCombined,
  ChevronRight,
  ClipboardList,
  Clock3,
  Fingerprint,
  Globe,
  House,
  Layers3,
  LogOut,
  Menu,
  Network,
  Settings2,
  ShieldCheck,
  UserRound,
  Users,
  Wallet,
  X,
} from "lucide-react";

const adminNavigation = [
  { label: "overview", href: "dashboard", icon: House },
  { label: "employees", href: "employees", icon: Users },
  { label: "attendance", href: "attendance", icon: CalendarCheck2 },
  { label: "lateApprovals", href: "late-approvals", icon: Clock3 },
  { label: "reports", href: "reports", icon: ChartNoAxesCombined },
  { label: "driveCost", href: "drive-cost", icon: CarFront },
  {
    label: "dailyExpenses",
    href: "/daily-expenses",
    icon: Wallet,
    canAccess: canManageDailyExpenses,
  },
  { label: "leaves", href: "leaves", icon: CalendarDays },
  { label: "devices", href: "devices", icon: Fingerprint },
  { label: "departments", href: "departments", icon: Layers3 },
  { label: "offices", href: "offices", icon: Building2 },
  { label: "networks", href: "networks", icon: Network },
  { label: "shifts", href: "shifts", icon: Clock3 },
  { label: "assignments", href: "assignments", icon: ClipboardList },
  { label: "holidays", href: "holidays", icon: CalendarDays },
  { label: "audit", href: "audit", icon: ShieldCheck },
  { label: "events", href: "events", icon: ShieldCheck },
  { label: "security", href: "/account/security", icon: ShieldCheck },
];
const employeeNavigation = [
  { label: "myDay", href: "dashboard", icon: House },
  { label: "history", href: "history", icon: CalendarCheck2 },
  { label: "leaves", href: "leaves", icon: CalendarDays },
  { label: "myDevices", href: "devices", icon: Fingerprint },
  { label: "profile", href: "profile", icon: UserRound },
  { label: "security", href: "/account/security", icon: ShieldCheck },
];
export function Brand() {
  return (
    <div className="brand workspace-brand">
      <Image
        className="workspace-brand-logo"
        src="/company_logo.jpeg"
        alt="XHYD"
        width={1082}
        height={205}
        sizes="148px"
      />
    </div>
  );
}

export function AppShell({
  children,
  user,
  mode,
}: {
  children: ReactNode;
  user: {
    id: string;
    profileSlug: string;
    name: string | null;
    email: string;
    role: string;
    image?: string | null;
    hasEmployeeProfile?: boolean;
  };
  mode: "admin" | "employee";
}) {
  const t = useTranslations("navigation");
  const common = useTranslations("common");
  const auth = useTranslations("auth");
  const store = useAppStore();
  const pathname = usePathname();
  async function signOutAction() {
    store.dispatch(workspaceClosed("signed-out"));
    clearWorkspaceData(store);
    await signOut({ redirectTo: "/login" });
  }
  const [open, setOpen] = useState(false);
  const navigation = [
    ...(mode === "admin"
      ? [
          ...adminNavigation.filter(
            (item) => !item.canAccess || item.canAccess(user.role),
          ),
          ...(user.hasEmployeeProfile
            ? [
                {
                  label: "employeeProfile",
                  href: "/employee/profile",
                  icon: UserRound,
                },
                {
                  label: "myWorkspace",
                  href: "/employee/dashboard",
                  icon: House,
                },
              ]
            : []),
          ...(user.role === "SUPER_ADMIN"
            ? [
                {
                  label: "profile",
                  href: `/admin/users/${encodeURIComponent(user.id)}/profile`,
                  icon: UserRound,
                },
                { label: "settings", href: "settings", icon: Settings2 },
              ]
            : []),
        ]
      : [
          ...employeeNavigation,
          ...(user.role === "MANAGE_DRIVER"
            ? [{ label: "driveCost", href: "drive-cost", icon: CarFront }]
            : []),
          ...(["ADMIN", "SUPER_ADMIN"].includes(user.role)
            ? [
                {
                  label: "adminWorkspace",
                  href: "/admin/dashboard",
                  icon: Building2,
                },
              ]
            : []),
        ]),
    {
      label: "publicProfile",
      href: `/profile/${encodeURIComponent(user.profileSlug)}`,
      icon: Globe,
    },
  ];
  const navigationHref = (href: string) =>
    href.startsWith("/") ? href : `/${mode}/${href}`;
  const current = navigation.find(
    (item) => pathname === navigationHref(item.href),
  );
  return (
    <div className="workspace workspace-theme">
      <a href="#main-content" className="skip-link">
        {t("skip")}
      </a>
      {open && (
        <button
          aria-label={t("closeNavigation")}
          className="sidebar-backdrop"
          onClick={() => setOpen(false)}
        />
      )}
      <aside className={`sidebar ${open ? "is-open" : ""}`}>
        <Link href={`/${mode}/dashboard`} aria-label={t("home")}>
          <Brand />
        </Link>
        <div className="workspace-label">
          {mode === "admin" ? t("workspace") : t("personalWorkspace")}
        </div>
        <nav aria-label={t("mainNavigation")}>
          {navigation.map(({ label, href, icon: Icon }) => (
            <Link
              onClick={() => setOpen(false)}
              key={href}
              href={navigationHref(href)}
              prefetch={href.startsWith("/profile/") ? false : undefined}
              className={`nav-item ${pathname === navigationHref(href) ? "active" : ""}`}
              aria-current={
                pathname === navigationHref(href) ? "page" : undefined
              }
            >
              <Icon size={18} />
              <span>
                {t(
                  label as keyof typeof import("../../messages/en/navigation.json"),
                )}
              </span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="secure-workspace">
            <ShieldCheck size={17} />
            <span>
              {t("secure")}
              <br />
              <small>{t("verified")}</small>
            </span>
          </div>
          <form action={signOutAction}>
            <button className="nav-item signout" type="submit">
              <LogOut size={18} />
              {t("signOut")}
            </button>
          </form>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label={open ? t("closeMenu") : t("openMenu")}
              onClick={() => setOpen(!open)}
            >
              {open ? <X size={20} /> : <Menu size={20} />}
            </button>
            <span>{mode === "admin" ? t("workspace") : t("myWorkspace")}</span>
            <ChevronRight size={14} />
            <strong>
              {t(
                (current?.label ||
                  "overview") as keyof typeof import("../../messages/en/navigation.json"),
              )}
            </strong>
          </div>
          <div className="topbar-user">
            <LanguageSwitcher />
            <span className="role-label">
              {common.has(
                `status.${user.role as keyof typeof import("../../messages/en/common.json").status}`,
              )
                ? common(
                    `status.${user.role as keyof typeof import("../../messages/en/common.json").status}`,
                  )
                : user.role}
            </span>
            {user.image ? (
              <Image
                unoptimized
                src={user.image}
                width={35}
                height={35}
                alt={t("googleProfile")}
                className="avatar"
              />
            ) : (
              <span className="avatar">
                {(user.name || user.email).slice(0, 2).toUpperCase()}
              </span>
            )}
          </div>
        </header>
        <main id="main-content" className="main-content">
          {children}
        </main>
        <footer className="workspace-footer">
          <span>{auth("title")}</span>
          <span>{t("footer")}</span>
        </footer>
      </div>
    </div>
  );
}
