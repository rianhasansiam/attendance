"use client";

import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { ArrowUpRight, Check, Copy, Mail, X } from "lucide-react";
import {
  businesses as defaultBusinesses,
  regions as companyRegions,
} from "@/data/company";
import styles from "./home.module.css";

/** Native dialogs provide the focus trap, inert background, and Escape behavior. */
export function useCorporateDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const previousOverflow = useRef<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  function restoreScroll() {
    if (previousOverflow.current !== null) {
      document.body.style.overflow = previousOverflow.current;
      previousOverflow.current = null;
    }
  }

  function open() {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    previousOverflow.current = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    setIsOpen(true);
  }

  function close() {
    dialogRef.current?.close();
  }

  function onClose() {
    restoreScroll();
    setIsOpen(false);
    if (triggerRef.current?.getClientRects().length) {
      triggerRef.current.focus({ preventScroll: true });
    }
  }

  function onBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    ) {
      close();
    }
  }

  useEffect(() => {
    return () => {
      if (previousOverflow.current !== null) {
        document.body.style.overflow = previousOverflow.current;
        previousOverflow.current = null;
      }
    };
  }, []);

  return {
    dialogRef,
    triggerRef,
    isOpen,
    open,
    close,
    onClose,
    onBackdropClick,
  };
}

export function CorporateMotion() {
  useEffect(() => {
    const site = document.getElementById("xhyd-site");
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!site || motion.matches || !("IntersectionObserver" in window)) return;

    const elements = Array.from(
      site.querySelectorAll<HTMLElement>("[data-reveal]"),
    );
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).dataset.revealState = "visible";
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.08, rootMargin: "0px 0px -32px 0px" },
    );

    // Content is visible without JavaScript. Only upcoming content is enhanced.
    for (const element of elements) {
      element.dataset.revealState =
        element.getBoundingClientRect().top >= window.innerHeight - 32
          ? "pending"
          : "visible";
      observer.observe(element);
    }

    function respectMotionPreference() {
      if (!motion.matches) return;
      observer.disconnect();
      for (const element of elements) {
        element.dataset.revealState = "visible";
      }
    }
    motion.addEventListener("change", respectMotionPreference);

    return () => {
      observer.disconnect();
      motion.removeEventListener("change", respectMotionPreference);
      for (const element of elements) delete element.dataset.revealState;
    };
  }, []);

  return null;
}

type BusinessOption = { id: string; title: string };
type RegionOption = { id: string; name: string };

type PartnershipContactProps = {
  email?: string | null;
  contactUrl?: string | null;
  businesses?: readonly BusinessOption[];
  regions?: readonly RegionOption[];
};

const anotherMarket: RegionOption = { id: "other", name: "Another market" };
const defaultRegions: readonly RegionOption[] = [
  ...companyRegions.map(({ id, name }) => ({ id, name })),
  anotherMarket,
];

export function PartnershipContact({
  email,
  contactUrl,
  businesses = defaultBusinesses,
  regions = defaultRegions,
}: PartnershipContactProps) {
  const {
    dialogRef,
    triggerRef,
    isOpen,
    open,
    close,
    onClose,
    onBackdropClick,
  } = useCorporateDialog();
  const id = useId();
  const regionOptions = regions.some(
    (option) =>
      option.id === anotherMarket.id || option.name === anotherMarket.name,
  )
    ? regions
    : [...regions, anotherMarket];
  const [business, setBusiness] = useState("");
  const [region, setRegion] = useState("");
  const [message, setMessage] = useState(
    "I'd like to explore a partnership with XHYD.\n\nAbout my company:\n\nWhat we could build together:\n\nMy contact details:",
  );
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const draft = [
    "Partnership inquiry for XHYD",
    business ? `Business area: ${business}` : null,
    region ? `Market: ${region}` : null,
    "",
    message,
  ]
    .filter((line) => line !== null)
    .join("\n");
  const emailHref = email
    ? `mailto:${email}?subject=${encodeURIComponent("Partnership inquiry for XHYD")}&body=${encodeURIComponent(draft)}`
    : null;

  useEffect(() => {
    if (copyStatus === "error") {
      draftRef.current?.focus();
      draftRef.current?.select();
    }
  }, [copyStatus]);

  async function copyInquiry() {
    try {
      await navigator.clipboard.writeText(draft);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  }

  function openInquiry() {
    setCopyStatus("idle");
    open();
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.contactButton}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={`${id}-dialog`}
        onClick={openInquiry}
      >
        Contact XHYD <ArrowUpRight size={18} aria-hidden="true" />
      </button>
      <dialog
        ref={dialogRef}
        id={`${id}-dialog`}
        className={styles.contactDialog}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        onClose={onClose}
        onClick={onBackdropClick}
      >
        <div className={styles.contactDialogHeader}>
          <span className={styles.contactKicker}>
            A conversation starts here
          </span>
          <button
            type="button"
            className={styles.contactClose}
            aria-label="Close partnership inquiry"
            onClick={close}
            autoFocus
          >
            <X size={21} aria-hidden="true" />
          </button>
        </div>
        <h2 id={`${id}-title`} className={styles.contactTitle}>
          Let’s explore what’s next.
        </h2>
        <p id={`${id}-description`} className={styles.contactDescription}>
          Prepare a short introduction to your business and the opportunity you
          have in mind.
        </p>
        {!email && !contactUrl && (
          <p className={styles.contactNote}>
            Our public contact details will be available here soon. You can
            prepare and save an inquiry in the meantime.
          </p>
        )}
        <div className={styles.contactForm}>
          <div className={styles.contactFieldRow}>
            <label className={styles.contactField} htmlFor={`${id}-business`}>
              Business area
              <select
                id={`${id}-business`}
                value={business}
                onChange={(event) => {
                  setBusiness(event.target.value);
                  setCopyStatus("idle");
                }}
              >
                <option value="">Let’s explore</option>
                {businesses.map((option) => (
                  <option key={option.id} value={option.title}>
                    {option.title}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.contactField} htmlFor={`${id}-region`}>
              Market
              <select
                id={`${id}-region`}
                value={region}
                onChange={(event) => {
                  setRegion(event.target.value);
                  setCopyStatus("idle");
                }}
              >
                <option value="">Select a market</option>
                {regionOptions.map((option) => (
                  <option key={option.id} value={option.name}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className={styles.contactField} htmlFor={`${id}-message`}>
            Your introduction
            <textarea
              id={`${id}-message`}
              value={message}
              rows={7}
              maxLength={5000}
              onChange={(event) => {
                setMessage(event.target.value);
                setCopyStatus("idle");
              }}
            />
          </label>
          {copyStatus === "error" && (
            <label className={styles.contactField} htmlFor={`${id}-draft`}>
              Select and copy your complete inquiry
              <textarea
                ref={draftRef}
                id={`${id}-draft`}
                className={styles.contactDraft}
                value={draft}
                rows={7}
                readOnly
              />
            </label>
          )}
          <p className={styles.contactNote}>
            This prepares a draft; it does not send it. Your draft stays in this
            page and is not saved when you leave.
          </p>
          <div className={styles.contactActions}>
            <button
              type="button"
              className={styles.contactCopy}
              onClick={copyInquiry}
            >
              {copyStatus === "copied" ? (
                <Check size={17} aria-hidden="true" />
              ) : (
                <Copy size={17} aria-hidden="true" />
              )}
              {copyStatus === "copied" ? "Inquiry copied" : "Copy inquiry"}
            </button>
            {emailHref && (
              <a href={emailHref} className={styles.contactEmail}>
                <Mail size={17} aria-hidden="true" /> Open email draft
              </a>
            )}
            {contactUrl && (
              <a href={contactUrl} className={styles.contactEmail}>
                Visit contact page <ArrowUpRight size={17} aria-hidden="true" />
              </a>
            )}
          </div>
          <p className={styles.contactStatus} role="status" aria-live="polite">
            {copyStatus === "copied"
              ? "Your inquiry is copied and ready to share."
              : copyStatus === "error"
                ? "Clipboard access is unavailable. Select and copy the complete inquiry above."
                : ""}
          </p>
        </div>
      </dialog>
      <noscript>
        <p className={styles.contactNote}>
          {email ? (
            <a href={`mailto:${email}`}>Email XHYD</a>
          ) : contactUrl ? (
            <a href={contactUrl}>Visit our contact page</a>
          ) : (
            "Our public contact details will be available here soon."
          )}
        </p>
      </noscript>
    </>
  );
}
