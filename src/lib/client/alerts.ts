"use client";

import type Swal from "sweetalert2";
import type { SweetAlertOptions, SweetAlertResult } from "sweetalert2";

type AlertLibrary = typeof Swal;
export type NotificationKind = "success" | "error" | "info" | "warning";
type Notification = { message: string; kind: NotificationKind };
type QueuedNotification = Notification & { key: string; subscribers: number };

let library: AlertLibrary | undefined;
let loading: Promise<AlertLibrary> | undefined;
let dialogOpen = false;
let generation = 0;
let draining = false;
let activeNotification: QueuedNotification | undefined;
const notifications = new Map<string, QueuedNotification>();

async function getLibrary() {
  loading ??= import("sweetalert2/dist/sweetalert2.js")
    .then((module) => {
      library = module.default;
      document.getElementById("alert-unavailable")?.remove();
      return library;
    })
    .catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
  return loading;
}

function showUnavailable() {
  if (document.getElementById("alert-unavailable")) return;
  const notice = document.createElement("div");
  notice.id = "alert-unavailable";
  notice.className = "notice error alert-unavailable";
  notice.setAttribute("role", "alert");
  notice.textContent =
    "The confirmation could not be opened. Reload the page and try again.";
  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "button secondary";
  reload.textContent = "Reload";
  reload.onclick = () => window.location.reload();
  notice.append(reload);
  document.body.append(notice);
}

const popupOptions = {
  heightAuto: false,
  buttonsStyling: false,
  showCancelButton: true,
  cancelButtonText: "Cancel",
  focusCancel: true,
  allowOutsideClick: false,
  keydownListenerCapture: true,
  returnFocus: false,
  customClass: {
    container: "app-alert-container",
    popup: "app-alert",
    title: "app-alert-title",
    htmlContainer: "app-alert-text",
    actions: "app-alert-actions",
    confirmButton: "button",
    cancelButton: "button secondary",
    input: "app-alert-input",
  },
} satisfies SweetAlertOptions;

async function openDialog(
  options: SweetAlertOptions,
): Promise<SweetAlertResult<string> | null> {
  // SweetAlert has one active popup. Never replace one confirmation with a
  // second click or an unrelated background notification.
  if (typeof window === "undefined" || dialogOpen) return null;
  dialogOpen = true;
  // Capture synchronously, before callers' busy state disables the trigger and
  // before the lazy import can move browser focus away from that button.
  const opener =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const openedGeneration = generation;
  if (activeNotification) library?.close();
  try {
    const alert = await getLibrary();
    if (openedGeneration !== generation) return null;
    const result = await alert.fire<string>({
      ...popupOptions,
      ...options,
      didClose: () => {
        if (
          openedGeneration === generation &&
          opener?.isConnected &&
          !opener.matches(":disabled") &&
          (document.activeElement === document.body ||
            document.activeElement === opener)
        ) {
          opener.focus({ preventScroll: true });
        }
      },
    });
    return openedGeneration === generation ? result : null;
  } catch {
    // A failed chunk load must never authorize a destructive action.
    if (openedGeneration === generation) showUnavailable();
    return null;
  } finally {
    if (openedGeneration === generation) dialogOpen = false;
    void drainNotifications();
  }
}

export async function confirmAction({
  title,
  text,
  confirmText = "Confirm",
  cancelText = "Cancel",
  danger = false,
}: {
  title: string;
  text: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}): Promise<boolean> {
  const result = await openDialog({
    titleText: title,
    text,
    icon: danger ? "warning" : "question",
    confirmButtonText: confirmText,
    cancelButtonText: cancelText,
    customClass: {
      ...popupOptions.customClass,
      confirmButton: danger ? "button danger" : "button",
    },
  });
  return result?.isConfirmed === true;
}

export async function promptAction({
  title,
  text,
  inputLabel,
  initialValue = "",
  placeholder = "",
  confirmText = "Save",
  maxLength = 1000,
  required = false,
}: {
  title: string;
  text?: string;
  inputLabel: string;
  initialValue?: string;
  placeholder?: string;
  confirmText?: string;
  maxLength?: number;
  required?: boolean;
}): Promise<string | null> {
  const result = await openDialog({
    titleText: title,
    text,
    input: "textarea",
    inputLabel,
    inputValue: initialValue,
    inputPlaceholder: placeholder,
    inputAttributes: { maxlength: String(maxLength) },
    confirmButtonText: confirmText,
    inputValidator: (value) => {
      if (required && !value.trim()) return "Enter a note before continuing.";
      if (value.length > maxLength)
        return `Use ${maxLength} characters or fewer.`;
    },
  });
  return result?.isConfirmed ? (result.value ?? "") : null;
}

/** Mirror persistent inline feedback without stealing focus or replacing a dialog. */
export function enqueueNotification(notification: Notification): () => void {
  if (typeof window === "undefined" || !notification.message) return () => {};
  const key = `${notification.kind}:${notification.message}`;
  const entry = notifications.get(key) ?? {
    ...notification,
    key,
    subscribers: 0,
  };
  entry.subscribers++;
  notifications.set(key, entry);
  queueMicrotask(() => void drainNotifications());
  return () => {
    entry.subscribers--;
    if (entry.subscribers > 0) return;
    if (notifications.get(key) === entry) notifications.delete(key);
    if (activeNotification === entry && !dialogOpen) library?.close();
  };
}

async function drainNotifications() {
  if (draining || dialogOpen) return;
  draining = true;
  const startedGeneration = generation;
  try {
    const alert = await getLibrary();
    while (!dialogOpen && startedGeneration === generation) {
      const entry = notifications.values().next().value as
        QueuedNotification | undefined;
      if (!entry) break;
      notifications.delete(entry.key);
      if (!entry.subscribers) continue;
      activeNotification = entry;
      await alert.fire({
        toast: true,
        position: "top-end",
        icon: entry.kind,
        titleText:
          entry.kind === "success"
            ? "Success"
            : entry.kind === "error"
              ? "Unable to complete the action"
              : "Notice",
        text: entry.message,
        showConfirmButton: false,
        showCloseButton: true,
        closeButtonAriaLabel: "Dismiss notification",
        timer: entry.kind === "error" ? 8000 : 5000,
        timerProgressBar: true,
        customClass: {
          container: "app-alert-container",
          popup: "app-alert app-alert-toast",
          title: "app-alert-title",
          htmlContainer: "app-alert-text",
        },
        didRender: (popup) => {
          // The inline message already owns the live announcement. Configure
          // this synchronously before opening to avoid announcing it twice.
          popup.setAttribute("role", "status");
          popup.setAttribute("aria-live", "off");
        },
        didOpen: (popup) => {
          popup.addEventListener("mouseenter", () => alert.stopTimer());
          popup.addEventListener("mouseleave", () => alert.resumeTimer());
          popup.addEventListener("focusin", () => alert.stopTimer());
          popup.addEventListener("focusout", () => alert.resumeTimer());
        },
      });
      if (activeNotification === entry) activeNotification = undefined;
    }
  } catch {
    // Notifications are enhancement only; the inline feedback remains visible.
    notifications.clear();
  } finally {
    draining = false;
    if (!dialogOpen && notifications.size) void drainNotifications();
  }
}

export function resetAlerts() {
  generation++;
  notifications.clear();
  activeNotification = undefined;
  dialogOpen = false;
  library?.close();
  document.getElementById("alert-unavailable")?.remove();
}
