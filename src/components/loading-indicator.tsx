"use client";
import { useTranslations } from "next-intl";
import { LoaderCircle } from "lucide-react";
// A fallback must not read request cookies while its parent is suspended.
export function LoadingIndicator() {
  const t = useTranslations("common");
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={22} /> {t("loading")}
    </div>
  );
}

export function ProfileLoadingIndicator({ className }: { className: string }) {
  const t = useTranslations("employee");
  return (
    <section className={className} role="status">
      {t("publicProfile.loading")}
    </section>
  );
}
