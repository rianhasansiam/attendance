"use client";
import { useSyncExternalStore } from "react";
import { setupListeners } from "@reduxjs/toolkit/query";
import type { AppDispatch } from "./make-store";

export function browserActive() {
  return document.visibilityState === "visible" && navigator.onLine;
}
function subscribe(callback: () => void) {
  document.addEventListener("visibilitychange", callback);
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    document.removeEventListener("visibilitychange", callback);
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}
const configuredInterval = Number(
  process.env.NEXT_PUBLIC_ATTENDANCE_POLL_MS || 60_000,
);
export const attendancePollMs = Number.isFinite(configuredInterval)
  ? Math.max(15_000, configuredInterval)
  : 60_000;

export function useFreshness(live = false) {
  const active = useSyncExternalStore(subscribe, browserActive, () => false);
  return {
    // Activity hides routes without destroying their state; restored subscriptions
    // must revalidate even when their cache entry is still retained.
    refetchOnMountOrArgChange: true,
    refetchOnFocus: true,
    refetchOnReconnect: true,
    pollingInterval: live && active ? attendancePollMs : 0,
    skipPollingIfUnfocused: true,
  };
}

export function listenToBrowser(dispatch: AppDispatch) {
  // Custom handler supports independent provider lifetimes, including Strict Mode.
  return setupListeners(dispatch, (send, actions) => {
    const focus = () =>
      send(browserActive() ? actions.onFocus() : actions.onFocusLost());
    const online = () => {
      send(actions.onOnline());
      focus();
    };
    const offline = () => {
      send(actions.onOffline());
      send(actions.onFocusLost());
    };
    window.addEventListener("focus", focus);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", focus);
    if (!navigator.onLine) offline();
    else if (document.visibilityState !== "visible")
      send(actions.onFocusLost());
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", focus);
    };
  });
}
