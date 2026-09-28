import { useLocale } from "next-intl";
import { useCallback } from "react";
import en from "../../messages/en/common.json";
import zh from "../../messages/zh-CN/common.json";
import enAuth from "../../messages/en/auth.json";
import zhAuth from "../../messages/zh-CN/auth.json";
import { resolveLocale } from "./config";

/** Only known application messages are translated; unknown server text is never displayed. */
export function localizeKnownMessage(message: string, locale: string): string {
  const pairs: [Record<string, unknown>, Record<string, unknown>][] = [
    [en, zh],
    [enAuth, zhAuth],
    [en.errors, zh.errors],
    [en.validation, zh.validation],
  ];
  for (const [source, target] of pairs) {
    const key = Object.keys(source).find(
      (key) => source[key] === message || target[key] === message,
    );
    if (key)
      return (
        resolveLocale(locale) === "en" ? source[key] : target[key]
      ) as string;
  }
  return message;
}
export function localizeError(
  error: unknown,
  locale: string,
  fallback?: string,
): string {
  const messages = resolveLocale(locale) === "zh-CN" ? zh : en;
  const rawMessage =
    error instanceof Error
      ? error.message
      : error &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : typeof error === "string"
          ? error
          : "";
  const known = [
    en,
    enAuth,
    en.errors,
    en.validation,
    zh,
    zhAuth,
    zh.errors,
    zh.validation,
  ].some((dictionary) => Object.values(dictionary).includes(rawMessage));
  if (known) return localizeKnownMessage(rawMessage, locale);
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    Object.hasOwn(messages.errors, error.code)
  ) {
    return messages.errors[error.code as keyof typeof messages.errors];
  }
  return fallback ?? messages.errors.REQUEST_FAILED;
}
export function useErrorMessage() {
  const locale = useLocale();
  return useCallback(
    (error: unknown, fallback?: string) =>
      localizeError(error, locale, fallback),
    [locale],
  );
}
