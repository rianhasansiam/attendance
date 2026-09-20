"use client";
import { useEffect, useState } from "react";
import { Download, WifiOff } from "lucide-react";
interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
export function PwaStatus() {
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
          You’re offline. Connect to the internet to record attendance.
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
          Install app
        </button>
      )}
    </>
  );
}
