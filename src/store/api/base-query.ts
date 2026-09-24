import {
  fetchBaseQuery,
  type BaseQueryFn,
  type FetchArgs,
} from "@reduxjs/toolkit/query";
import { normalizeError, type ApiError } from "./errors";
import { workspaceClosed } from "../features/workspace-ui/slice";
import { signalSession, SESSION_CHECK } from "@/lib/client/session-events";

const request = fetchBaseQuery({
  baseUrl: "/",
  credentials: "same-origin",
  cache: "no-store",
  timeout: 30_000,
});
function closed(state: unknown) {
  return (
    (state as { workspaceUi: { status: string } }).workspaceUi.status !==
    "active"
  );
}
const closedError: ApiError = {
  status: "SESSION_CLOSED",
  code: "SESSION_CLOSED",
  message: "This workspace session has ended.",
};

// No retries: ambiguous writes must be reconciled by a read, never replayed.
export const baseQuery: BaseQueryFn<
  string | FetchArgs,
  unknown,
  ApiError
> = async (args, api, extra) => {
  if (closed(api.getState())) return { error: closedError };
  const result = await request(args, api, extra);
  // Also fence late responses after logout/reset while requests were in flight.
  if (closed(api.getState())) return { error: closedError };
  if (result.error) {
    const status =
      result.error.status === "PARSING_ERROR" &&
      result.error.originalStatus >= 400
        ? result.error.originalStatus
        : result.error.status;
    const error = normalizeError(
      status,
      "data" in result.error ? result.error.data : undefined,
    );
    const retryAfter = result.meta?.response?.headers.get("Retry-After");
    if (retryAfter) error.retryAfter = retryAfter;
    if (status === 401) api.dispatch(workspaceClosed("expired"));
    if (
      status === 403 &&
      ["USER_INACTIVE", "USER_NOT_AUTHORIZED"].includes(error.code)
    )
      api.dispatch(workspaceClosed("forbidden"));
    return { error };
  }
  const envelope = result.data as { success?: boolean; data?: unknown } | null;
  if (!envelope?.success) return { error: normalizeError(500, result.data) };
  if (
    typeof args !== "string" &&
    args.method &&
    args.method !== "GET" &&
    /\/api\/admin\/(users|employees)(\/|$)/.test(args.url)
  )
    signalSession(SESSION_CHECK);
  // Do not forward transport metadata (Request/Response) into application actions.
  return { data: envelope.data };
};
