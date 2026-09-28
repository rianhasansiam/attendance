"use client";
import {
  NextIntlClientProvider,
  useMessages,
  useLocale,
  type AbstractIntlMessages,
} from "next-intl";
import type { ReactNode } from "react";
/** Only the current workspace's dictionary is serialized to the browser. */
export function FeatureProvider({
  messages,
  children,
}: {
  messages: AbstractIntlMessages;
  children: ReactNode;
}) {
  const shared = useMessages();
  const locale = useLocale();
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={{ ...shared, ...messages }}
    >
      {children}
    </NextIntlClientProvider>
  );
}
