"use client";
import { normalizeError, type ApiError } from "@/store/api/errors";
import { signalAccessFailure } from "./session-events";

export class ClientRequestError extends Error {
  readonly status: ApiError["status"];
  readonly code: string;
  readonly fields?: ApiError["fields"];
  constructor(error: ApiError) {
    super(error.message);
    this.name = "ClientRequestError";
    this.status = error.status;
    this.code = error.code;
    this.fields = error.fields;
  }
}

/** Sensitive browser ceremonies only: never dispatch arguments or raw results. */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  init?.signal?.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch (error) {
    init?.signal?.throwIfAborted();
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError"
    )
      throw error;
    throw new ClientRequestError(normalizeError("FETCH_ERROR"));
  }
  init?.signal?.throwIfAborted();
  const body = await response.json().catch((error: unknown) => {
    init?.signal?.throwIfAborted();
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError"
    )
      throw error;
    return null;
  });
  init?.signal?.throwIfAborted();
  if (!response.ok || !body?.success) {
    const error = normalizeError(response.ok ? 500 : response.status, body);
    signalAccessFailure(error.status, error.code);
    throw new ClientRequestError(error);
  }
  return body.data as T;
}
