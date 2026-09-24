"use client";

import { useCallback } from "react";
import { useSearchParams } from "next/navigation";

/** URL-owned, shareable filters. Draft form inputs may remain local until applied. */
export function useUrlFilters() {
  const params = useSearchParams();
  const update = useCallback(
    (patch: Record<string, string | number | null | undefined>) => {
      // Read the latest URL so two updates in the same event cannot overwrite
      // one another with the previous render's search parameters.
      const url = new URL(window.location.href);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined || value === "") {
          url.searchParams.delete(key);
        } else {
          url.searchParams.set(key, String(value));
        }
      }
      window.history.replaceState(
        null,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    },
    [],
  );
  return { params, update };
}

export function pageFromSearch(value: string | null, maximum = 100000) {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 && page <= maximum ? page : 1;
}
