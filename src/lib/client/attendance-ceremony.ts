"use client";

import type {
  startAuthentication,
  startRegistration as StartRegistration,
} from "@simplewebauthn/browser";
import { api } from "./request";
import {
  beginAttendanceTiming,
  type AttendanceTimingTrace,
} from "./attendance-timing";
import type {
  AttendanceRecord,
  DeviceMetadata,
} from "@/store/features/attendance/contracts";

/** A write may have committed. Read authoritative state before another attempt. */
export function isAmbiguousWrite(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  )
    return false;
  if (!error || typeof error !== "object" || !("status" in error)) return true;
  return typeof error.status !== "number" || error.status >= 500;
}

export class UncertainCeremonyError extends Error {
  constructor() {
    super(
      "The server response was interrupted. Checking the latest state before another attempt.",
    );
    this.name = "UncertainCeremonyError";
  }
}

const locationFreshnessMs = 30_000;
type LocationFix = {
  location: { latitude: number; longitude: number; accuracy: number };
  receivedAt: number;
  ageAtReceipt: number;
};

function getLocation(signal?: AbortSignal): Promise<LocationFix> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    if (!navigator.geolocation)
      return reject(
        new Error(
          "Location is unavailable in this browser. Use a supported browser with location enabled.",
        ),
      );
    const abort = () => {
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", abort);
    navigator.geolocation.getCurrentPosition(
      ({ coords, timestamp }) => {
        cleanup();
        if (signal?.aborted) return;
        resolve({
          location: {
            latitude: coords.latitude,
            longitude: coords.longitude,
            accuracy: coords.accuracy,
          },
          receivedAt: performance.now(),
          ageAtReceipt: Number.isFinite(timestamp)
            ? Math.max(0, Date.now() - timestamp)
            : 0,
        });
      },
      (error) => {
        cleanup();
        if (signal?.aborted) return;
        reject(
          new Error(
            error.code === 1
              ? "Location permission is required. Allow location access in your browser and try again."
              : "Your location could not be determined. Move near a window and try again.",
          ),
        );
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  });
}

/** Unknown/prompt permissions stay sequential to avoid competing browser prompts. */
async function canOverlapLocation(signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  if (!navigator.permissions?.query) return false;
  return new Promise((resolve, reject) => {
    // Permission inspection is optional. A slow/unavailable implementation must
    // not strand an attendance attempt before either verification can begin.
    const timer = setTimeout(() => finish(false), 200);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const finish = (granted: boolean) => {
      cleanup();
      resolve(granted);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      void navigator.permissions.query({ name: "geolocation" }).then(
        (permission) => finish(permission.state === "granted"),
        () => finish(false),
      );
    } catch {
      finish(false);
    }
  });
}

function locationIsFresh(fix: LocationFix) {
  return (
    fix.ageAtReceipt + performance.now() - fix.receivedAt <= locationFreshnessMs
  );
}

async function verifyWithDevice<T>(
  run: () => Promise<T>,
  cancel: () => void,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cancel();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    run()
      .then((value) => {
        if (signal?.aborted) reject(signal.reason);
        else resolve(value);
      }, reject)
      .finally(() => signal?.removeEventListener("abort", abort));
  });
}

// Challenge/assertion/GPS exist only on this stack and in secure HTTP bodies.
// No Redux imports, dispatches, retries, retained request objects, or logging.
export async function recordAttendance({
  action,
  progress,
  signal,
  timing = beginAttendanceTiming(action),
}: {
  action: "CHECK_IN" | "CHECK_OUT";
  progress: (message: string) => void;
  signal?: AbortSignal;
  timing?: AttendanceTimingTrace;
}): Promise<AttendanceRecord> {
  signal?.throwIfAborted();
  const attempt = new AbortController();
  const abort = () => attempt.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const attemptSignal = attempt.signal;
  try {
    progress("Preparing verification…");
    const challenge = await timing.measure("options", () =>
      api<{
        required: boolean;
        requireGeofence: boolean;
        challengeId?: string;
        options?: Parameters<typeof startAuthentication>[0]["optionsJSON"];
      }>("/api/webauthn/authenticate/options", {
        method: "POST",
        body: JSON.stringify({ action }),
        signal: attemptSignal,
        headers: timing.headers,
      }),
    );
    attemptSignal.throwIfAborted();
    if (
      typeof challenge.required !== "boolean" ||
      typeof challenge.requireGeofence !== "boolean" ||
      (challenge.required && (!challenge.options || !challenge.challengeId))
    )
      throw new Error(
        "Verification requirements are unavailable. Please try again.",
      );

    const authenticate = async () => {
      if (!challenge.required) return undefined;
      return timing.measure("passkey", async () => {
        const { startAuthentication, WebAuthnAbortService } =
          await import("@simplewebauthn/browser");
        attemptSignal.throwIfAborted();
        return verifyWithDevice(
          () => startAuthentication({ optionsJSON: challenge.options! }),
          () => WebAuthnAbortService.cancelCeremony(),
          attemptSignal,
        );
      });
    };
    const locate = () =>
      timing.measure("gps", () => getLocation(attemptSignal));
    let response;
    let fix: LocationFix | undefined;
    const overlap =
      challenge.required &&
      challenge.requireGeofence &&
      (await canOverlapLocation(attemptSignal));
    attemptSignal.throwIfAborted();
    if (overlap) {
      progress("Verify your device while your location is acquired…");
      // Promise.all attaches rejection handlers to both branches immediately.
      // The outer catch aborts the sibling and ignores its later completion.
      [response, fix] = await Promise.all([authenticate(), locate()]);
    } else {
      if (challenge.required) progress("Verify with your registered device…");
      response = await authenticate();
      attemptSignal.throwIfAborted();
      if (challenge.requireGeofence) {
        progress("Getting your location…");
        fix = await locate();
      }
    }
    attemptSignal.throwIfAborted();
    if (fix && !locationIsFresh(fix)) {
      progress("Refreshing your location…");
      fix = await timing.measure("gps-refresh", () =>
        getLocation(attemptSignal),
      );
      attemptSignal.throwIfAborted();
      if (!locationIsFresh(fix))
        throw new Error(
          "A fresh location could not be obtained. Please try again.",
        );
    }
    progress("Recording your attendance…");
    try {
      const record = await timing.measure("post", () =>
        api<AttendanceRecord>(
          `/api/attendance/${action === "CHECK_IN" ? "check-in" : "check-out"}`,
          {
            method: "POST",
            signal: attemptSignal,
            headers: timing.headers,
            body: JSON.stringify({
              challengeId: challenge.challengeId,
              response,
              location: fix?.location,
            }),
          },
        ),
      );
      attemptSignal.throwIfAborted();
      timing.mark("post-confirmed");
      return record;
    } catch (error) {
      attemptSignal.throwIfAborted();
      if (isAmbiguousWrite(error)) throw new UncertainCeremonyError();
      throw error;
    }
  } catch (error) {
    attempt.abort(error);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export async function registerDevice(
  name: string,
  signal?: AbortSignal,
): Promise<DeviceMetadata> {
  signal?.throwIfAborted();
  const challenge = await api<{
    challengeId: string;
    options: Parameters<typeof StartRegistration>[0]["optionsJSON"];
  }>("/api/webauthn/register/options", { method: "POST", body: "{}", signal });
  signal?.throwIfAborted();
  const { startRegistration, WebAuthnAbortService } =
    await import("@simplewebauthn/browser");
  signal?.throwIfAborted();
  const response = await verifyWithDevice(
    () => startRegistration({ optionsJSON: challenge.options }),
    () => WebAuthnAbortService.cancelCeremony(),
    signal,
  );
  signal?.throwIfAborted();
  try {
    const device = await api<DeviceMetadata>("/api/webauthn/register/verify", {
      method: "POST",
      signal,
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        response,
        name,
      }),
    });
    signal?.throwIfAborted();
    return device;
  } catch (error) {
    signal?.throwIfAborted();
    if (isAmbiguousWrite(error)) throw new UncertainCeremonyError();
    throw error;
  }
}
