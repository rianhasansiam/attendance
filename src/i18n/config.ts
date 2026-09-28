export const locales = ["en", "zh-CN"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";
export const localeCookie = "attendance-locale";
export const localeMaxAge = 60 * 60 * 24 * 365;
export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "zh-CN";
}
export function resolveLocale(value: unknown): Locale {
  return isLocale(value) ? value : defaultLocale;
}
