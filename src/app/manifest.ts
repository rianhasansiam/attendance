import { getLocale, getTranslations } from "next-intl/server";
import type { MetadataRoute } from "next";
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const t = await getTranslations("auth");
  const locale = await getLocale();
  return {
    name: t("title"),
    short_name: "XHYD",
    description: t("description"),
    lang: locale,
    start_url: "/employee/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#f7f7f8",
    theme_color: "#101010",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
