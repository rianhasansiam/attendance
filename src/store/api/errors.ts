export type ApiError = {
  status: number | string;
  code: string;
  message: string;
  fields?: Record<string, string[]>;
  fieldErrors?: Record<string, string[]>;
  retryAfter?: string;
};

export function isApiError(error: unknown): error is ApiError {
  return (
    !!error &&
    typeof error === "object" &&
    "status" in error &&
    "message" in error &&
    typeof error.message === "string"
  );
}

export function errorMessage(
  error: unknown,
  fallback = "Unable to complete the request. Please try again.",
): string {
  if (isApiError(error) || error instanceof Error) return error.message;
  return fallback;
}

export function isAccessError(error: unknown): boolean {
  return isApiError(error) && (error.status === 401 || error.status === 403);
}

export function normalizeError(
  status: number | string,
  body?: unknown,
): ApiError {
  const envelope =
    body && typeof body === "object" && "error" in body
      ? body.error
      : undefined;
  const detail = envelope && typeof envelope === "object" ? envelope : {};
  const code =
    status === 401
      ? "UNAUTHENTICATED"
      : status === 403
        ? "FORBIDDEN"
        : status === 409
          ? "CONFLICT"
          : status === 429
            ? "RATE_LIMITED"
            : status === "FETCH_ERROR"
              ? "NETWORK_ERROR"
              : status === "TIMEOUT_ERROR"
                ? "TIMEOUT"
                : "REQUEST_FAILED";
  const message =
    status === 401
      ? "Your session has expired. Please sign in again."
      : status === 403
        ? "You do not have access to this resource."
        : status === 429
          ? "Too many requests. Wait before trying again."
          : status === "FETCH_ERROR" ||
              status === "TIMEOUT_ERROR" ||
              status === "PARSING_ERROR"
            ? "The request could not be confirmed. Refresh to check its status before trying again."
            : "Unable to complete the request. Please try again.";
  const rawFields =
    "fieldErrors" in detail
      ? detail.fieldErrors
      : "fields" in detail
        ? detail.fields
        : undefined;
  const fields =
    rawFields && typeof rawFields === "object"
      ? Object.fromEntries(
          Object.entries(rawFields).filter(
            (entry): entry is [string, string[]] =>
              Array.isArray(entry[1]) &&
              entry[1].every((value) => typeof value === "string"),
          ),
        )
      : undefined;
  return {
    status,
    code:
      "code" in detail && typeof detail.code === "string" ? detail.code : code,
    message:
      "message" in detail && typeof detail.message === "string"
        ? detail.message
        : message,
    ...(fields ? { fields, fieldErrors: fields } : {}),
  };
}
