"use client";

import type {
  startAuthentication,
  startRegistration as StartRegistration,
} from "@simplewebauthn/browser";
import { api } from "./request";
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

function getLocation(signal?: AbortSignal): Promise<{
  latitude: number;
  longitude: number;
  accuracy: number;
}> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    if (!navigator.geolocation)
      return reject(
        new Error(
          "Location is unavailable in this browser. Use a supported browser with location enabled.",
        ),
      );
    const abort = () => reject(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", abort);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        cleanup();
        if (signal?.aborted) return;
        resolve({
          latitude: coords.latitude,
          longitude: coords.longitude,
          accuracy: coords.accuracy,
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
  requireGeofence,
  progress,
  signal,
}: {
  action: "CHECK_IN" | "CHECK_OUT";
  requireGeofence: boolean;
  progress: (message: string) => void;
  signal?: AbortSignal;
}): Promise<AttendanceRecord> {
  signal?.throwIfAborted();
  progress("Preparing verification…");
  const challenge = await api<{
    required?: boolean;
    challengeId?: string;
    options?: Parameters<typeof startAuthentication>[0]["optionsJSON"];
  }>("/api/webauthn/authenticate/options", {
    method: "POST",
    body: JSON.stringify({ action }),
    signal,
  });
  signal?.throwIfAborted();
  let response;
  if (challenge.required !== false && challenge.options) {
    progress("Verify with your registered device…");
    const { startAuthentication, WebAuthnAbortService } =
      await import("@simplewebauthn/browser");
    signal?.throwIfAborted();
    const options = challenge.options;
    response = await verifyWithDevice(
      () => startAuthentication({ optionsJSON: options }),
      () => WebAuthnAbortService.cancelCeremony(),
      signal,
    );
    signal?.throwIfAborted();
  }
  let location;
  if (requireGeofence) {
    progress("Getting your location…");
    location = await getLocation(signal);
    signal?.throwIfAborted();
  }
  progress("Recording your attendance…");
  try {
    const record = await api<AttendanceRecord>(
      `/api/attendance/${action === "CHECK_IN" ? "check-in" : "check-out"}`,
      {
        method: "POST",
        signal,
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          response,
          location,
        }),
      },
    );
    signal?.throwIfAborted();
    return record;
  } catch (error) {
    signal?.throwIfAborted();
    if (isAmbiguousWrite(error)) throw new UncertainCeremonyError();
    throw error;
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
