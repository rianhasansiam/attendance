import type { Metadata, Viewport } from "next";
import { PwaStatus } from "@/components/pwa";
import "./globals.css";
export const metadata: Metadata = {
  title: { default: "XHYD Attendance System", template: "%s · Attend" },
  description: "A secure, considered workspace for everyday attendance.",
  applicationName: "Attend",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Attend" },
  icons: { icon: "/icon.svg", apple: "/icons/icon-192.png" },
};
export const viewport: Viewport = {
  themeColor: "#17664d",
  width: "device-width",
  initialScale: 1,
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        {children}
        <PwaStatus />
      </body>
    </html>
  );
}
