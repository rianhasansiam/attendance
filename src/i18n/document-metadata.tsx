"use client";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

/** React 19 hoists these SSR-rendered tags to <head>. Keeping localized metadata
 * in the locale tree also handles layouts that redirect before rendering a page:
 * Next 16.3's generateMetadata prerender validation cannot track that case. */
export function DocumentMetadata() {
  const pathname = usePathname();
  const auth = useTranslations("auth");
  const navigation = useTranslations("navigation");
  const common = useTranslations("common");
  // The public corporate homepage owns its server-rendered English metadata.
  if (pathname === "/") return null;
  const publicProfile = pathname.startsWith("/profile/");
  const title = publicProfile
    ? `${navigation("publicProfile")} · XHYD`
    : pathname === "/account/security"
      ? `${auth("security")} · XHYD`
      : auth("title");
  return (
    <>
      <title>{title}</title>
      <meta
        name="description"
        content={
          publicProfile
            ? common("publicProfileDescription")
            : auth("description")
        }
      />
    </>
  );
}
