// Signals contain no identity, session, or operation data. Auth.js owns cross-tab sync.
export const SESSION_CHECK = "attendance:session-check";
export const SESSION_EXPIRED = "attendance:session-expired";
export const ACCOUNT_FORBIDDEN = "attendance:account-forbidden";
export function signalSession(event: string) {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(event));
}
export function signalAccessFailure(status: number | string, code: string) {
  if (status === 401) signalSession(SESSION_EXPIRED);
  if (status === 403 && ["USER_INACTIVE", "USER_NOT_AUTHORIZED"].includes(code))
    signalSession(ACCOUNT_FORBIDDEN);
}
