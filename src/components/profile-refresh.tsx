"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/** Revalidate retained Server Component data without copying the profile into Redux. */
export function ProfileRefresh() {
  const router = useRouter();
  const activated = useRef(false);
  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const refresh = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      window.clearTimeout(timer);
      // Focus and visibility/reconnect events commonly arrive together.
      timer = window.setTimeout(() => {
        if (
          !disposed &&
          document.visibilityState === "visible" &&
          navigator.onLine
        )
          router.refresh();
      }, 100);
    };
    if (activated.current) refresh();
    // Skip both the fresh initial render and Strict Mode's immediate effect replay.
    queueMicrotask(() => {
      if (!disposed) activated.current = true;
    });
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);
  return null;
}
