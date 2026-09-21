"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
  Building2,
  CalendarCheck2,
  CalendarDays,
  CarFront,
  ChartNoAxesCombined,
  CheckCheck,
  ChevronRight,
  ClipboardList,
  Clock3,
  Fingerprint,
  House,
  Layers3,
  LogOut,
  Menu,
  Network,
  Settings2,
  ShieldCheck,
  UserRound,
  Users,
  X,
} from "lucide-react";

const adminNavigation = [
  { label: "Overview", href: "dashboard", icon: House },
  { label: "Employees", href: "employees", icon: Users },
  { label: "Attendance", href: "attendance", icon: CalendarCheck2 },
  { label: "Reports", href: "reports", icon: ChartNoAxesCombined },
  { label: "Drive Cost", href: "drive-cost", icon: CarFront },
  { label: "Leave requests", href: "leaves", icon: CalendarDays },
  { label: "Devices", href: "devices", icon: Fingerprint },
  { label: "Departments", href: "departments", icon: Layers3 },
  { label: "Offices", href: "offices", icon: Building2 },
  { label: "Office networks", href: "networks", icon: Network },
  { label: "Shifts", href: "shifts", icon: Clock3 },
  { label: "Shift assignments", href: "assignments", icon: ClipboardList },
  { label: "Holidays", href: "holidays", icon: CalendarDays },
  { label: "Audit log", href: "audit", icon: ShieldCheck },
  { label: "Security events", href: "events", icon: ShieldCheck },
];
const employeeNavigation = [
  { label: "My day", href: "dashboard", icon: House },
  { label: "Attendance history", href: "history", icon: CalendarCheck2 },
  { label: "Leave requests", href: "leaves", icon: CalendarDays },
  { label: "My devices", href: "devices", icon: Fingerprint },
  { label: "My profile", href: "profile", icon: UserRound },
];
export function Brand() {
  return (
    <div className="brand">
      <span className="brand-icon">
        <CheckCheck size={24} strokeWidth={2.5} />
      </span>

      <span>BangBuy</span>
    </div>
  );
}
export function AppShell({
  children,
  user,
  mode,
  signOutAction,
}: {
  children: ReactNode;
  user: {
    name: string | null;
    email: string;
    role: string;
    image?: string | null;
  };
  mode: "admin" | "employee";
  signOutAction: () => Promise<void>;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const navigation =
    mode === "admin"
      ? [
          ...adminNavigation,
          ...(user.role === "SUPER_ADMIN"
            ? [
                { label: "Administrators", href: "users", icon: ShieldCheck },
                { label: "Settings", href: "settings", icon: Settings2 },
              ]
            : []),
        ]
      : employeeNavigation;
  const current = navigation.find(
    (item) => pathname === `/${mode}/${item.href}`,
  );
  return (
    <div className="workspace">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      {open && (
        <button
          aria-label="Close navigation"
          className="sidebar-backdrop"
          onClick={() => setOpen(false)}
        />
      )}
      <aside className={`sidebar ${open ? "is-open" : ""}`}>
        <Link href={`/${mode}/dashboard`} aria-label="Attendance home">
          <Brand />
        </Link>
        <div className="workspace-label">
          {mode === "admin" ? "WORKSPACE" : "PERSONAL WORKSPACE"}
        </div>
        <nav aria-label="Main navigation">
          {navigation.map(({ label, href, icon: Icon }) => (
            <Link
              onClick={() => setOpen(false)}
              key={href}
              href={`/${mode}/${href}`}
              className={`nav-item ${pathname === `/${mode}/${href}` ? "active" : ""}`}
              aria-current={
                pathname === `/${mode}/${href}` ? "page" : undefined
              }
            >
              <Icon size={18} />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="secure-workspace">
            <ShieldCheck size={17} />
            <span>
              Secure attendance
              <br />
              <small>Verified. Every workday.</small>
            </span>
          </div>
          <form action={signOutAction}>
            <button className="nav-item signout" type="submit">
              <LogOut size={18} />
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={() => setOpen(!open)}
            >
              {open ? <X size={20} /> : <Menu size={20} />}
            </button>
            <span>{mode === "admin" ? "Workspace" : "My workspace"}</span>
            <ChevronRight size={14} />
            <strong>{current?.label || "Overview"}</strong>
          </div>
          <div className="topbar-user">
            <span className="role-label">{user.role.replaceAll("_", " ")}</span>
            {user.image ? (
              <Image
                unoptimized
                src={user.image}
                width={35}
                height={35}
                alt="Google profile"
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
          <span>BangBuy Attendance System</span>
          <span>A little more clarity in every workday.</span>
        </footer>
      </div>
    </div>
  );
}
