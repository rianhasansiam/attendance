import {
  randomBytes,
  randomUUID,
  generateKeyPairSync,
  createHash,
  sign,
} from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { db } from "../src/lib/db";
import {
  attendanceEvidenceSchema,
  recordAttendance,
} from "../src/modules/attendance/service";
import {
  authenticationOptions,
  consumeChallenge,
  registerCredential,
  registrationOptions,
  type EmployeeActor,
} from "../src/modules/webauthn/service";
import { registrationInputSchema } from "../src/modules/webauthn/validation";

const testDatabase = process.env.TEST_DATABASE_URL;
const integration = testDatabase ? describe : describe.skip;
const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest();
const b64 = (data: Uint8Array | string) =>
  Buffer.from(data).toString("base64url");

integration("PostgreSQL attendance and WebAuthn integration", () => {
  beforeAll(() => {
    if (!testDatabase || !new URL(testDatabase).pathname.includes("test"))
      throw new Error(
        "Integration tests require an isolated database with 'test' in its name",
      );
    Object.assign(process.env, {
      DATABASE_URL: testDatabase,
      NODE_ENV: "test",
      AUTH_SECRET: "test-only-auth-secret-with-at-least-32-characters",
      AUTH_URL: "http://localhost:3000",
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
      WEBAUTHN_RP_ID: "localhost",
      WEBAUTHN_RP_NAME: "Attendance tests",
      WEBAUTHN_ORIGIN: "http://localhost:3000",
      TRUSTED_PROXY_MODE: "none",
    });
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  async function fixture(requireWebAuthn = false): Promise<EmployeeActor> {
    const suffix = randomUUID();
    const office = await db.office.create({
      data: {
        name: `Test ${suffix}`,
        address: "Test",
        latitude: 0,
        longitude: 0,
        requireWebAuthn,
        requireGeofence: false,
        requireOfficeNetwork: false,
      },
    });
    const shift = await db.shift.create({
      data: {
        name: `Test ${suffix}`,
        startTime: "00:00",
        endTime: "23:59",
        timezone: "UTC",
      },
    });
    const user = await db.user.create({
      data: {
        email: `attendance-${suffix}@example.test`,
        name: "Attendance test",
        googleAccountId: suffix,
        employee: {
          create: {
            employeeCode: suffix,
            officeId: office.id,
            shifts: {
              create: {
                shiftId: shift.id,
                startDate: new Date("2020-01-01T00:00:00Z"),
              },
            },
          },
        },
      },
      include: { employee: true },
    });
    const session = await db.session.create({
      data: {
        userId: user.id,
        sessionToken: randomUUID(),
        expires: new Date(Date.now() + 3_600_000),
      },
    });
    return { ...user, employee: user.employee!, sessionId: session.id };
  }

  it("serializes simultaneous check-ins with exactly one successful record and event", async () => {
    const actor = await fixture();
    const results = await Promise.allSettled([
      recordAttendance(actor, "CHECK_IN", {}, new Headers()),
      recordAttendance(actor, "CHECK_IN", {}, new Headers()),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      await db.attendance.count({ where: { employeeId: actor.employee.id } }),
    ).toBe(1);
    expect(
      await db.attendanceEvent.count({
        where: { employeeId: actor.employee.id, type: "CHECK_IN_SUCCESS" },
      }),
    ).toBe(1);
    expect(
      await db.attendanceEvent.count({
        where: { employeeId: actor.employee.id, type: "CHECK_IN_REJECTED" },
      }),
    ).toBe(1);
  });

  it("serializes simultaneous checkouts and rejects checkout with no check-in", async () => {
    const actor = await fixture();
    await expect(
      recordAttendance(actor, "CHECK_OUT", {}, new Headers()),
    ).rejects.toMatchObject({ code: "NOT_CHECKED_IN" });
    await recordAttendance(actor, "CHECK_IN", {}, new Headers());
    const results = await Promise.allSettled([
      recordAttendance(actor, "CHECK_OUT", {}, new Headers()),
      recordAttendance(actor, "CHECK_OUT", {}, new Headers()),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const record = await db.attendance.findFirstOrThrow({
      where: { employeeId: actor.employee.id },
    });
    expect(record.checkOutAt).toBeInstanceOf(Date);
    expect(record.workedMinutes).toBeGreaterThanOrEqual(0);
  });

  it("rechecks database authorization after the route has resolved its session", async () => {
    const actor = await fixture();
    await db.session.delete({ where: { id: actor.sessionId } });
    await expect(
      recordAttendance(actor, "CHECK_IN", {}, new Headers()),
    ).rejects.toMatchObject({ code: "USER_NOT_AUTHORIZED" });
    expect(
      await db.attendance.count({ where: { employeeId: actor.employee.id } }),
    ).toBe(0);
  });

  it("enforces geofence and trusted network before writing attendance", async () => {
    const actor = await fixture();
    await db.office.update({
      where: { id: actor.employee.officeId },
      data: { requireGeofence: true, requireOfficeNetwork: true },
    });
    await expect(
      recordAttendance(
        actor,
        "CHECK_IN",
        { location: { latitude: 10, longitude: 10, accuracy: 10 } },
        new Headers(),
      ),
    ).rejects.toMatchObject({ code: "OUTSIDE_GEOFENCE" });
    await expect(
      recordAttendance(
        actor,
        "CHECK_IN",
        { location: { latitude: 0, longitude: 0, accuracy: 70 } },
        new Headers(),
      ),
    ).rejects.toMatchObject({ code: "GPS_ACCURACY_TOO_LOW" });
    await expect(
      recordAttendance(
        actor,
        "CHECK_IN",
        { location: { latitude: 0, longitude: 0, accuracy: 10 } },
        new Headers({
          "x-forwarded-for": "127.0.0.1",
          "x-real-ip": "127.0.0.1",
        }),
      ),
    ).rejects.toMatchObject({ code: "WRONG_NETWORK" });
    expect(
      await db.attendance.count({ where: { employeeId: actor.employee.id } }),
    ).toBe(0);
  });

  it("atomically consumes only one copy of a challenge and rejects expiry", async () => {
    const actor = await fixture();
    const challenge = await db.webAuthnChallenge.create({
      data: {
        employeeId: actor.employee.id,
        sessionId: actor.sessionId,
        purpose: "CHECK_IN",
        challenge: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const results = await Promise.allSettled([
      consumeChallenge(actor, "CHECK_IN", challenge.id),
      consumeChallenge(actor, "CHECK_IN", challenge.id),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const expired = await db.webAuthnChallenge.create({
      data: {
        employeeId: actor.employee.id,
        sessionId: actor.sessionId,
        purpose: "CHECK_IN",
        challenge: randomUUID(),
        expiresAt: new Date(Date.now() - 1),
      },
    });
    await expect(
      consumeChallenge(actor, "CHECK_IN", expired.id),
    ).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
  });

  it("verifies a real ES256 registration and signed attendance assertion; rejects replay, unapproved and revoked devices", async () => {
    const actor = await fixture(true);
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = keys.publicKey.export({ format: "jwk" });
    const publicKey = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
    const credentialId = randomBytes(32);
    const options = await registrationOptions(actor);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(credentialId.length);
    const authData = Buffer.concat([
      hash("localhost"),
      Buffer.from([0x45]),
      Buffer.alloc(4),
      Buffer.alloc(16),
      length,
      credentialId,
      publicKey,
    ]);
    const attestation = isoCBOR.encode(
      new Map<string, string | Uint8Array | Map<string, string>>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    const response: RegistrationResponseJSON = {
      id: b64(credentialId),
      rawId: b64(credentialId),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64(
          JSON.stringify({
            type: "webauthn.create",
            challenge: options.options.challenge,
            origin: "http://localhost:3000",
          }),
        ),
        attestationObject: b64(attestation),
        transports: ["internal"],
      },
    };
    const device = await registerCredential(
      actor,
      registrationInputSchema.parse({
        name: "Test authenticator",
        challengeId: options.challengeId,
        response,
      }),
    );
    expect(device.approved).toBe(false);
    await expect(
      authenticationOptions(actor, "CHECK_IN"),
    ).rejects.toMatchObject({ code: "NO_APPROVED_DEVICE" });
    await db.webAuthnCredential.update({
      where: { id: device.id },
      data: { approved: true },
    });

    async function assertion(
      action: "CHECK_IN" | "CHECK_OUT",
      counter: number,
    ) {
      const options = await authenticationOptions(actor, action);
      if (!options.required) throw new Error("WebAuthn must be required");
      const counterBytes = Buffer.alloc(4);
      counterBytes.writeUInt32BE(counter);
      const authData = Buffer.concat([
        hash("localhost"),
        Buffer.from([0x05]),
        counterBytes,
      ]);
      const clientData = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge: options.options.challenge,
          origin: "http://localhost:3000",
        }),
      );
      const signed: AuthenticationResponseJSON = {
        id: b64(credentialId),
        rawId: b64(credentialId),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          authenticatorData: b64(authData),
          clientDataJSON: b64(clientData),
          signature: b64(
            sign(
              "sha256",
              Buffer.concat([authData, hash(clientData)]),
              keys.privateKey,
            ),
          ),
        },
      };
      return attendanceEvidenceSchema.parse({
        challengeId: options.challengeId,
        response: signed,
      });
    }
    const evidence = await assertion("CHECK_IN", 1);
    await expect(
      recordAttendance(actor, "CHECK_IN", evidence, new Headers()),
    ).resolves.toMatchObject({ checkOutAt: null });
    await expect(
      recordAttendance(actor, "CHECK_IN", evidence, new Headers()),
    ).rejects.toMatchObject({ code: "CHALLENGE_REUSED" });
    const unapprovedEvidence = await assertion("CHECK_OUT", 2);
    await db.webAuthnCredential.update({
      where: { id: device.id },
      data: { approved: false },
    });
    await expect(
      recordAttendance(actor, "CHECK_OUT", unapprovedEvidence, new Headers()),
    ).rejects.toMatchObject({ code: "DEVICE_NOT_APPROVED" });
    await db.webAuthnCredential.update({
      where: { id: device.id },
      data: { approved: true },
    });
    const revokeEvidence = await assertion("CHECK_OUT", 2);
    await db.webAuthnCredential.update({
      where: { id: device.id },
      data: { revokedAt: new Date() },
    });
    await expect(
      recordAttendance(actor, "CHECK_OUT", revokeEvidence, new Headers()),
    ).rejects.toMatchObject({ code: "DEVICE_REVOKED" });
    expect(
      (
        await db.webAuthnChallenge.findUniqueOrThrow({
          where: { id: revokeEvidence.challengeId! },
        })
      ).usedAt,
    ).not.toBeNull();
    expect(
      (
        await db.webAuthnCredential.findUniqueOrThrow({
          where: { id: device.id },
        })
      ).counter,
    ).toBe(BigInt(1));
  });
});
