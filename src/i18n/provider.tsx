"use client";
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl";
import { useEffect, type ReactNode } from "react";
import type { Locale } from "./config";
export function LocaleProvider({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages: AbstractIntlMessages;
  children: ReactNode;
}) {
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      timeZone="Asia/Dhaka"
      onError={(error) => {
        if (process.env.NODE_ENV === "development")
          console.error("[i18n]", error);
      }}
      getMessageFallback={() => "Unable to display this text."}
    >
      {children}
    </NextIntlClientProvider>
  );
}
