import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { localeCookie, resolveLocale } from "./config";
import { loadMessages } from "./messages";
export default getRequestConfig(async () => {
  const locale = resolveLocale((await cookies()).get(localeCookie)?.value);
  return {
    locale,
    messages: await loadMessages(locale),
    // Explicit default prevents server/browser timezone differences. Office-specific
    // attendance displays continue to pass their own configured business timezone.
    timeZone: "Asia/Dhaka",
    onError(error) {
      if (process.env.NODE_ENV === "development")
        console.error("[i18n]", error);
    },
    getMessageFallback() {
      return "Unable to display this text.";
    },
  };
});
