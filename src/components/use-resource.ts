"use client";

import { useCallback, useEffect, useState } from "react";

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success)
    throw new Error(
      body?.error?.message ||
        "Unable to complete this request. Please try again.",
    );
  return body.data as T;
}

/** Request state only: no data is reused between requests or route visits. */
export function useResource<T>(url: string) {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{
    url: string;
    version: number;
    data: T | null;
    error: string;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<T>(url, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted)
          setState({ url, version, data, error: "" });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            url,
            version,
            data: null,
            error:
              error instanceof Error ? error.message : "Unable to load data.",
          });
      });
    return () => {
      controller.abort();
      // Cache Components hides routes with Activity. Clearing on cleanup keeps
      // old attendance/device data out of the next reveal while its effect restarts.
      setState(null);
    };
  }, [url, version]);

  const refresh = useCallback(() => {
    setState(null);
    setVersion((previous) => previous + 1);
  }, []);
  const current =
    state?.url === url && state.version === version ? state : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? "",
    loading: current === null,
    refresh,
  };
}

export function useDebouncedValue<T>(value: T, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timeout);
  }, [value, delay]);
  return debounced;
}
