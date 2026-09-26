import "server-only";
import type { Prisma } from "@prisma/client";

const privateEvidence =
  /^(access_token|refresh_token|id_token|sessionToken|googleAccountId|publicKey|counter|credentialId|challenge|secret|password|passwordHash|tokenHash|resetToken|token|newPassword|currentPassword|confirmPassword|cookie|clientDataJSON|authenticatorData|signature|attestationObject|distanceMeters|check(?:In|Out)(?:Latitude|Longitude|Accuracy|DistanceMeters|Ip|CredentialId))$/i;

/** The database retains its audit evidence; browser display DTOs exclude it. */
export function auditDisplaySnapshot(
  value: Prisma.JsonValue,
): Prisma.JsonValue {
  if (Array.isArray(value)) return value.map(auditDisplaySnapshot);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        privateEvidence.test(key)
          ? "[redacted]"
          : auditDisplaySnapshot(item ?? null),
      ]),
    );
  }
  return value;
}
