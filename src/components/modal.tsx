"use client";

import { useEffect, useEffectEvent, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onClose = useEffectEvent(close);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const container = ref.current;
    container
      ?.querySelector<HTMLElement>(
        "button, input, select, textarea, [tabindex]",
      )
      ?.focus();
    const onKey = (event: KeyboardEvent) => {
      // SweetAlert owns keyboard focus while a confirmation is above a form.
      if (
        document.querySelector(
          ".swal2-container .swal2-popup:not(.swal2-toast)",
        )
      )
        return;
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const focusable = container?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
      );
      if (!focusable?.length) return;
      const first = focusable[0],
        last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal"
      >
        <div className="card-header">
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close dialog"
            onClick={close}
          >
            <X size={19} />
          </button>
        </div>
        <div className="card-body">{children}</div>
      </div>
    </div>
  );
}
