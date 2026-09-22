"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { ErrorNotice } from "./ui";

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
  const [error, setError] = useState("");
  async function download() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(href, { cache: "no-store" });
      if (
        !response.ok ||
        !response.headers.get("Content-Type")?.includes("application/pdf")
      ) {
        const body = await response.json().catch(() => null);
        throw new Error(
          body?.error?.message ||
            "Unable to generate the PDF. Please try again.",
        );
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download =
        response.headers
          .get("Content-Disposition")
          ?.match(/filename="([^"]+)"/)?.[1] || filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to generate the PDF.",
      );
    } finally {
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
        {busy ? "Generating PDF…" : "Download PDF"}
      </button>
      <ErrorNotice message={error} />
    </div>
  );
}
