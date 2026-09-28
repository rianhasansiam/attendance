"use client";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Download, WifiOff } from "lucide-react";
interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
export function PwaStatus() {
  const t = useTranslations("common");
  const [online, setOnline] = useState(true);
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    const install = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPrompt);
    };
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    window.addEventListener("beforeinstallprompt", install);
    if ("serviceWorker" in navigator)
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch(() => undefined);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
      window.removeEventListener("beforeinstallprompt", install);
    };
  }, []);
  return (
    <>
      {!online && (
        <div className="offline-banner" role="alert">
          <WifiOff size={17} />
          {t("offline")}
        </div>
      )}
      {prompt && (
        <button
          className="install-button"
          onClick={async () => {
            await prompt.prompt();
            await prompt.userChoice;
            setPrompt(null);
          }}
        >
          <Download size={16} />
          {t("install")}
        </button>
      )}
    </>
  );
}
