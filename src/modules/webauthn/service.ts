import {
  Prisma,
  type ChallengePurpose,
  type User,
  type Employee,
  type WebAuthnCredential,
} from "@prisma/client";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
} from "@simplewebauthn/server";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { DomainError } from "@/lib/errors";
import { resolveAttendancePolicy } from "@/modules/attendance/policy";
import {
  assertChallengeUsable,
  assertCredentialUsable,
  registrationInputSchema,
} from "./validation";
import type { z } from "zod";

export type EmployeeActor = User & { employee: Employee; sessionId: string };
export const deviceSelect = {
  id: true,
  name: true,
  approved: true,
  revokedAt: true,
  deviceType: true,
  backedUp: true,
  createdAt: true,
} satisfies Prisma.WebAuthnCredentialSelect;
const transports = (credential: Pick<WebAuthnCredential, "transports">) =>
  credential.transports as AuthenticatorTransport[];

async function storeChallenge(
  actor: EmployeeActor,
  purpose: ChallengePurpose,
  challenge: string,
) {
  const created = await db.webAuthnChallenge.create({
    data: {
      employeeId: actor.employee.id,
      sessionId: actor.sessionId,
      purpose,
      challenge,
      expiresAt: new Date(Date.now() + 5 * 60_000),
    },
    select: { id: true },
  });
  return created.id;
}

export async function consumeChallenge(
  actor: EmployeeActor,
  purpose: ChallengePurpose,
  challengeId: string,
) {
  const challenge = await db.webAuthnChallenge.findUnique({
    where: { id: challengeId },
  });
  const now = new Date();
  assertChallengeUsable(
    challenge,
    { employeeId: actor.employee.id, sessionId: actor.sessionId, purpose },
    now,
  );
  // Atomic compare-and-set is committed separately, so a failed assertion or
  // attendance transaction still consumes the challenge and cannot be replayed.
  const consumed = await db.webAuthnChallenge.updateMany({
    where: {
      id: challengeId,
      employeeId: actor.employee.id,
      sessionId: actor.sessionId,
      purpose,
      usedAt: null,
      expiresAt: { gt: now },
    },
    data: { usedAt: now },
  });
  if (consumed.count !== 1 || !challenge)
    throw new DomainError(
      "CHALLENGE_REUSED",
      "This verification request has already been used. Please try again.",
    );
  return challenge.challenge;
}

export async function registrationOptions(actor: EmployeeActor) {
  const env = getEnv();
  const credentials = await db.webAuthnCredential.findMany({
    where: { employeeId: actor.employee.id },
  });
  if (credentials.filter((credential) => !credential.revokedAt).length >= 10)
    throw new DomainError(
      "DEVICE_LIMIT",
      "Revoke an unused device before adding another.",
    );
  const options = await generateRegistrationOptions({
    rpName: env.WEBAUTHN_RP_NAME,
    rpID: env.WEBAUTHN_RP_ID,
    userName: actor.email,
    userDisplayName: actor.name ?? actor.email,
    userID: new TextEncoder().encode(actor.employee.id),
    attestationType: "none",
    timeout: 60_000,
    excludeCredentials: credentials.map((credential) => ({
      id: credential.credentialId,
      transports: transports(credential),
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
  });
  return {
    challengeId: await storeChallenge(actor, "REGISTRATION", options.challenge),
    options,
  };
}

export async function registerCredential(
  actor: EmployeeActor,
  input: z.infer<typeof registrationInputSchema>,
) {
  const expectedChallenge = await consumeChallenge(
    actor,
    "REGISTRATION",
    input.challengeId,
  );
  const env = getEnv();
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge,
      expectedOrigin: env.WEBAUTHN_ORIGIN,
      expectedRPID: env.WEBAUTHN_RP_ID,
      requireUserVerification: true,
    });
  } catch {
    throw new DomainError(
      "WEBAUTHN_FAILED",
      "Passkey registration could not be verified. Please try again.",
    );
  }
  if (!verification.verified)
    throw new DomainError(
      "WEBAUTHN_FAILED",
      "Passkey registration could not be verified. Please try again.",
    );
  const info = verification.registrationInfo;
  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${actor.employee.id} FOR UPDATE`;
      const currentUser = await tx.user.findUniqueOrThrow({
        where: { id: actor.id },
      });
      const session = await tx.session.findFirst({
        where: {
          id: actor.sessionId,
          userId: actor.id,
          expires: { gt: new Date() },
        },
        select: { id: true },
      });
      if (
        currentUser.status !== "ACTIVE" ||
        !currentUser.googleAccountId ||
        currentUser.googleAccountId !== actor.googleAccountId ||
        !session
      ) {
        throw new DomainError(
          "USER_NOT_AUTHORIZED",
          "Your authorization has changed. Sign in again.",
          403,
        );
      }
      const count = await tx.webAuthnCredential.count({
        where: { employeeId: actor.employee.id, revokedAt: null },
      });
      if (count >= 10)
        throw new DomainError(
          "DEVICE_LIMIT",
          "Revoke an unused device before adding another.",
        );
      const credential = await tx.webAuthnCredential.create({
        data: {
          employeeId: actor.employee.id,
          name: input.name,
          credentialId: info.credential.id,
          publicKey: Buffer.from(info.credential.publicKey),
          counter: BigInt(info.credential.counter),
          transports: info.credential.transports ?? [],
          deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp,
          approved: false,
        },
        select: deviceSelect,
      });
      await tx.attendanceEvent.create({
        data: {
          employeeId: actor.employee.id,
          type: "DEVICE_REGISTERED",
          metadata: { deviceId: credential.id },
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "DEVICE_REGISTERED",
          resource: "WebAuthnCredential",
          resourceId: credential.id,
          newState: { name: credential.name, approved: false },
        },
      });
      return credential;
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      throw new DomainError(
        "DEVICE_EXISTS",
        "This passkey is already registered.",
        409,
      );
    throw error;
  }
}

export async function authenticationOptions(
  actor: EmployeeActor,
  action: "CHECK_IN" | "CHECK_OUT",
) {
  const office = await db.office.findUniqueOrThrow({
    where: { id: actor.employee.officeId },
  });
  if (!office.active)
    throw new DomainError(
      "OFFICE_INACTIVE",
      "Your assigned office is inactive.",
    );
  const policy = resolveAttendancePolicy(office);
  if (!policy.requireWebAuthn) return { required: false as const };
  const credentials = await db.webAuthnCredential.findMany({
    where: {
      employeeId: actor.employee.id,
      revokedAt: null,
      ...(policy.requireApprovedDevice ? { approved: true } : {}),
    },
  });
  if (!credentials.length)
    throw new DomainError(
      "NO_APPROVED_DEVICE",
      "Register a passkey and have an administrator approve it before attendance.",
    );
  const options = await generateAuthenticationOptions({
    rpID: getEnv().WEBAUTHN_RP_ID,
    userVerification: "required",
    timeout: 60_000,
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialId,
      transports: transports(credential),
    })),
  });
  return {
    required: true as const,
    challengeId: await storeChallenge(actor, action, options.challenge),
    options,
  };
}

export async function verifyAttendanceAssertion(
  tx: Prisma.TransactionClient,
  actor: EmployeeActor,
  response: AuthenticationResponseJSON,
  challenge: string,
  requireApproved: boolean,
) {
  const initial = await tx.webAuthnCredential.findUnique({
    where: { credentialId: response.id },
  });
  if (!initial || initial.employeeId !== actor.employee.id)
    throw new DomainError(
      "WEBAUTHN_FAILED",
      "This passkey does not belong to your account.",
    );
  await tx.$queryRaw`SELECT id FROM "WebAuthnCredential" WHERE id = ${initial.id} FOR UPDATE`;
  const credential = await tx.webAuthnCredential.findUniqueOrThrow({
    where: { id: initial.id },
  });
  assertCredentialUsable(credential, requireApproved);
  const env = getEnv();
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: env.WEBAUTHN_ORIGIN,
      expectedRPID: env.WEBAUTHN_RP_ID,
      requireUserVerification: true,
      credential: {
        id: credential.credentialId,
        publicKey: new Uint8Array(credential.publicKey),
        counter: Number(credential.counter),
        transports: transports(credential),
      },
    });
  } catch {
    throw new DomainError(
      "WEBAUTHN_FAILED",
      "Passkey verification failed. Please try again.",
    );
  }
  if (!verification.verified)
    throw new DomainError(
      "WEBAUTHN_FAILED",
      "Passkey verification failed. Please try again.",
    );
  await tx.webAuthnCredential.update({
    where: { id: credential.id },
    data: {
      counter: BigInt(verification.authenticationInfo.newCounter),
      backedUp: verification.authenticationInfo.credentialBackedUp,
    },
  });
  return credential.id;
}

export async function revokeOwnCredential(actor: EmployeeActor, id: string) {
  return db.$transaction(async (tx) => {
    const updated = await tx.webAuthnCredential.updateMany({
      where: { id, employeeId: actor.employee.id, revokedAt: null },
      data: { revokedAt: new Date(), approved: false },
    });
    if (updated.count !== 1)
      throw new DomainError("NOT_FOUND", "Device not found.", 404);
    await tx.attendanceEvent.create({
      data: {
        employeeId: actor.employee.id,
        type: "DEVICE_REVOKED",
        metadata: { deviceId: id },
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action: "DEVICE_REVOKED",
        resource: "WebAuthnCredential",
        resourceId: id,
      },
    });
    return { id, revoked: true };
  });
}
