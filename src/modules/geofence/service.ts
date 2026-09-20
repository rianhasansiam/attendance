import { z } from "zod";
import { DomainError } from "@/lib/errors";

export const locationSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    accuracy: z.number().finite().positive().max(100_000),
  })
  .strict();
export type LocationEvidence = z.infer<typeof locationSchema>;

export function calculateDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return (
    6_371_000 *
    2 *
    Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)))
  );
}

export function verifyGeofence(
  location: LocationEvidence | undefined,
  office: {
    latitude: number;
    longitude: number;
    geofenceRadiusMeters: number;
  },
  maximumGpsAccuracyMeters: number,
): number {
  const parsed = locationSchema.safeParse(location);
  if (!parsed.success)
    throw new DomainError(
      "LOCATION_REQUIRED",
      "Allow location access and try again.",
    );
  if (parsed.data.accuracy > maximumGpsAccuracyMeters) {
    throw new DomainError(
      "GPS_ACCURACY_TOO_LOW",
      "Your location is not accurate enough. Move near a window and try again.",
    );
  }
  const distance = calculateDistanceMeters(
    parsed.data.latitude,
    parsed.data.longitude,
    office.latitude,
    office.longitude,
  );
  if (distance > office.geofenceRadiusMeters) {
    throw new DomainError(
      "OUTSIDE_GEOFENCE",
      "You are outside the BangBuy attendance area.",
    );
  }
  return distance;
}
