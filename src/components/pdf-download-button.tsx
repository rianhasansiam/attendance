"use client";
import { useTranslations } from "next-intl";

import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { useErrorMessage } from "@/i18n/errors";
import { ErrorNotice } from "./ui";
import { signalAccessFailure } from "@/lib/client/session-events";

export function PdfDownloadButton({
  href,
  filename,
  disabled = false,
}: {
  href: string;
  filename: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const t = useTranslations("common");
  const errorMessage = useErrorMessage();
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const urls = useRef(new Set<string>());
  useEffect(() => {
    const pendingUrls = urls.current;
    return () => {
      request.current?.abort();
      for (const url of pendingUrls) URL.revokeObjectURL(url);
      pendingUrls.clear();
    };
  }, []);
  async function download() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(href, {
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (
        !response.ok ||
        !response.headers.get("Content-Type")?.includes("application/pdf")
      ) {
        const body = await response.json().catch(() => null);
        signalAccessFailure(response.status, body?.error?.code || "");
        throw new Error(t("pdfFailed"));
      }
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      urls.current.add(url);
      const link = document.createElement("a");
      link.href = url;
      link.download =
        response.headers
          .get("Content-Disposition")
          ?.match(/filename="([^"]+)"/)?.[1] || filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
      }, 1000);
    } catch (error) {
      if (controller.signal.aborted) return;
      setError(errorMessage(error, t("pdfFailed")));
    } finally {
      request.current = null;
      setBusy(false);
    }
  }
  return (
    <div>
      <button
        type="button"
        className="button secondary"
        disabled={disabled || busy}
        onClick={() => void download()}
      >
        <Download size={15} />
        {busy ? t("generatingPdf") : t("downloadPdf")}
      </button>
      <ErrorNotice message={error} />
    </div>
  );
}
