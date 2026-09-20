import { z } from "zod";
import { DomainError } from "@/lib/errors";

const base64url = z
  .string()
  .min(1)
  .max(100_000)
  .regex(/^[A-Za-z0-9_-]+$/);
const extensions = z.record(z.string(), z.unknown());
const transport = z.enum([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);
export const authenticationResponseSchema = z
  .object({
    id: base64url,
    rawId: base64url,
    type: z.literal("public-key"),
    authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
    clientExtensionResults: extensions,
    response: z
      .object({
        clientDataJSON: base64url,
        authenticatorData: base64url,
        signature: base64url,
        userHandle: base64url.optional(),
      })
      .strict(),
  })
  .strict();
export const registrationResponseSchema = z
  .object({
    id: base64url,
    rawId: base64url,
    type: z.literal("public-key"),
    authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
    clientExtensionResults: extensions,
    response: z
      .object({
        clientDataJSON: base64url,
        attestationObject: base64url,
        transports: z.array(transport).max(10).optional(),
        publicKeyAlgorithm: z.number().int().optional(),
        publicKey: base64url.optional(),
        authenticatorData: base64url.optional(),
      })
      .strict(),
  })
  .strict();
export const registrationInputSchema = z
  .object({
    challengeId: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(80),
    response: registrationResponseSchema,
  })
  .strict();

export function assertChallengeUsable(
  challenge: {
    employeeId: string;
    sessionId: string;
    purpose: string;
    expiresAt: Date;
    usedAt: Date | null;
  } | null,
  expected: { employeeId: string; sessionId: string; purpose: string },
  now: Date,
): void {
  if (
    !challenge ||
    challenge.employeeId !== expected.employeeId ||
    challenge.sessionId !== expected.sessionId ||
    challenge.purpose !== expected.purpose
  ) {
    throw new DomainError(
      "WEBAUTHN_FAILED",
      "The verification request is invalid. Please try again.",
    );
  }
  if (challenge.usedAt)
    throw new DomainError(
      "CHALLENGE_REUSED",
      "This verification request has already been used. Please try again.",
    );
  if (challenge.expiresAt <= now)
    throw new DomainError(
      "CHALLENGE_EXPIRED",
      "Verification expired. Please try again.",
    );
}

export function assertCredentialUsable(
  credential: { revokedAt: Date | null; approved: boolean } | null,
  requireApproved: boolean,
): void {
  if (!credential || credential.revokedAt)
    throw new DomainError(
      "DEVICE_REVOKED",
      "This passkey is unavailable or has been revoked.",
    );
  if (requireApproved && !credential.approved)
    throw new DomainError(
      "DEVICE_NOT_APPROVED",
      "An administrator must approve this device before attendance.",
    );
}
