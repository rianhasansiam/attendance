"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import {
  enqueueNotification,
  resetAlerts,
  type NotificationKind,
} from "@/lib/client/alerts";
import {
  ACCOUNT_FORBIDDEN,
  SESSION_EXPIRED,
} from "@/lib/client/session-events";

export function AlertNotification({
  message,
  kind,
}: {
  message: string;
  kind: NotificationKind;
}) {
  useEffect(() => enqueueNotification({ message, kind }), [message, kind]);
  return null;
}

export function AlertLifecycle() {
  const pathname = usePathname();
  const previousPath = useRef(pathname);
  useLayoutEffect(() => {
    if (previousPath.current !== pathname) resetAlerts();
    previousPath.current = pathname;
  }, [pathname]);
  useEffect(() => {
    const events = ["pagehide", SESSION_EXPIRED, ACCOUNT_FORBIDDEN];
    for (const event of events) window.addEventListener(event, resetAlerts);
    return () => {
      for (const event of events)
        window.removeEventListener(event, resetAlerts);
    };
  }, []);
  return null;
}
