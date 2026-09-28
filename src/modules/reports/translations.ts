import "server-only";
import { createTranslator } from "next-intl";
import english from "../../../messages/en/reports.json";
import chinese from "../../../messages/zh-CN/reports.json";
import { withEnglishFallback } from "@/i18n/messages";
import { resolveLocale } from "@/i18n/config";

export function createReportTranslator(selectedLocale: string = "en") {
  const locale = resolveLocale(selectedLocale);
  const reports =
    locale === "en"
      ? english
      : (withEnglishFallback(english, chinese) as typeof english);
  return createTranslator({
    locale,
    messages: { reports },
    namespace: "reports",
  });
}
