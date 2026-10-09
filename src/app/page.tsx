import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { connection } from "next/server";
import { Suspense } from "react";
import { CorporateHomepage } from "@/components/corporate/home-page";
import { company } from "@/data/company";

const manrope = localFont({
  src: "../assets/fonts/manrope/Manrope-Variable.ttf",
  weight: "200 800",
  display: "swap",
  variable: "--xhyd-font",
  fallback: ["Arial", "Helvetica", "sans-serif"],
});

// Optional verified corporate origin; never infer it from the attendance host.
function configuredSiteUrl(): URL | undefined {
  try {
    const url = new URL(process.env.XHYD_SITE_URL || "");
    return url.protocol === "https:" ? new URL(url.origin) : undefined;
  } catch {
    return undefined;
  }
}
const siteUrl = configuredSiteUrl();
const title = "XHYD — Connecting Innovation, Industry & Global Markets";

export const metadata: Metadata = {
  title,
  description: company.description,
  applicationName: "XHYD",
  appleWebApp: { capable: false, title: "XHYD" },
  ...(siteUrl ? { metadataBase: siteUrl, alternates: { canonical: "/" } } : {}),
  icons: { icon: "/images/xhyd/favicon.svg" },
  openGraph: {
    type: "website",
    title,
    description: company.description,
    siteName: "XHYD",
    locale: "en_US",
    ...(siteUrl
      ? {
          url: siteUrl.href,
          images: [
            {
              url: "/images/xhyd/social-card.png",
              width: 1200,
              height: 630,
              alt: "XHYD — Innovation, industry and global markets",
            },
          ],
        }
      : {}),
  },
  twitter: {
    card: "summary_large_image",
    title,
    description: company.description,
    ...(siteUrl ? { images: ["/images/xhyd/social-card.png"] } : {}),
  },
};

export const viewport: Viewport = {
  themeColor: "#101010",
  width: "device-width",
  initialScale: 1,
};

function publicContact() {
  const value = process.env.XHYD_CONTACT_EMAIL?.trim();
  const email =
    value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : undefined;
  let contactUrl: string | undefined;
  try {
    const url = new URL(process.env.XHYD_CONTACT_URL || "");
    if (url.protocol === "https:") contactUrl = url.href;
  } catch {
    /* A missing contact channel is presented honestly in the UI. */
  }
  return { email, contactUrl };
}

const organization = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: company.name,
  description: company.description,
  address: { "@type": "PostalAddress", addressCountry: "CN" },
  ...(siteUrl ? { url: siteUrl.href } : {}),
};

export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(organization).replace(/</g, "\\u003c"),
        }}
      />
      <Suspense fallback={null}>
        <CurrentHomepage />
      </Suspense>
    </>
  );
}
async function CurrentHomepage() {
  // Read the current copyright year at request time with cache components.
  await connection();
  const year = Number(
    new Intl.DateTimeFormat("en", {
      year: "numeric",
      timeZone: "Asia/Dhaka",
    }).format(new Date()),
  );
  return (
    <CorporateHomepage
      year={year}
      {...publicContact()}
      fontClassName={manrope.variable}
    />
  );
}
