import type { AbstractIntlMessages } from "next-intl";
import { resolveLocale, type Locale } from "./config";

export function withEnglishFallback(
  english: AbstractIntlMessages,
  selected: AbstractIntlMessages,
  reportMissing = process.env.NODE_ENV === "development",
  prefix = "",
): AbstractIntlMessages {
  const result: AbstractIntlMessages = {};
  for (const [key, value] of Object.entries(english)) {
    const translated = selected[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      if (typeof translated === "string" && translated.trim())
        result[key] = translated;
      else {
        result[key] = value;
        if (reportMissing)
          console.warn(`[i18n] Missing translation: ${path}; using English.`);
      }
    } else {
      result[key] = withEnglishFallback(
        value,
        typeof translated === "object" && translated ? translated : {},
        reportMissing,
        path,
      );
    }
  }
  return result;
}

export async function loadMessages(preference: Locale) {
  const locale = resolveLocale(preference);
  const namespaces = [
    "common",
    "auth",
    "navigation",
    "admin",
    "employee",
    "expenses",
    "reports",
    "salary",
  ] as const;
  const messages: AbstractIntlMessages = {};
  for (const namespace of namespaces) {
    const english = (await import(`../../messages/en/${namespace}.json`))
      .default;
    messages[namespace] =
      locale === "en"
        ? english
        : withEnglishFallback(
            english,
            (await import(`../../messages/zh-CN/${namespace}.json`)).default,
          );
  }
  return messages;
}
