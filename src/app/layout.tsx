import { DocumentMetadata } from "@/i18n/document-metadata";
import { connection } from "next/server";
import { getLocale, getMessages } from "next-intl/server";
import { LocaleProvider } from "@/i18n/provider";
import { resolveLocale } from "@/i18n/config";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Suspense } from "react";
import { AlertLifecycle } from "@/components/alert-notification";
import { PwaStatus } from "@/components/pwa";
import "sweetalert2/dist/sweetalert2.min.css";
import "./globals.css";

const siteFont = localFont({
  src: "../assets/fonts/manrope/Manrope-Variable.ttf",
  weight: "200 800",
  display: "swap",
  variable: "--font-site",
  fallback: ["Arial", "Helvetica", "sans-serif"],
});

export const metadata: Metadata = {
  applicationName: "XHYD",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "XHYD" },
  icons: { icon: "/icon.svg", apple: "/icons/icon-192.png" },
};
export const viewport: Viewport = {
  themeColor: "#101010",
  width: "device-width",
  initialScale: 1,
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <Suspense fallback={null}>
      <LocaleDocument>{children}</LocaleDocument>
    </Suspense>
  );
}
async function LocaleDocument({ children }: { children: React.ReactNode }) {
  await connection();
  const locale = resolveLocale(await getLocale());
  const messages = await getMessages();
  return (
    <html lang={locale}>
      <body className={siteFont.variable}>
        <LocaleProvider
          locale={locale}
          messages={{
            common: messages.common,
            auth: messages.auth,
            navigation: messages.navigation,
          }}
        >
          <Suspense fallback={null}>
            <DocumentMetadata />
            <AlertLifecycle />
          </Suspense>
          {children}
          <PwaStatus />
        </LocaleProvider>
      </body>
    </html>
  );
}
