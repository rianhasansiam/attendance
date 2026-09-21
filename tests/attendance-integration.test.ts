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
  employeeDashboard,
  recordAttendance,
  saveLateReason,
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
const proxySecret = "test-only-proxy-secret-with-at-least-32-characters";
const officeHeaders = (ip = "192.0.2.10") =>
  new Headers({
    "x-real-ip": ip,
    "x-attendance-proxy-secret": proxySecret,
  });

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
      TRUSTED_PROXY_MODE: "nginx",
      TRUSTED_PROXY_SECRET: proxySecret,
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

  it("persists a late reason once and exposes it in fresh dashboard reads", async () => {
    const actor = await fixture();
    const checkedIn = await recordAttendance(
      actor,
      "CHECK_IN",
      {},
      new Headers(),
    );
    await db.attendance.update({
      where: { id: checkedIn.id },
      data: { lateMinutes: 20, status: "LATE" },
    });
    const input = { attendanceId: checkedIn.id, reason: "  Train delayed.  " };
    const saved = await saveLateReason(actor, input);
    expect(saved.lateReason).toBe("Train delayed.");
    expect(await saveLateReason(actor, input)).toEqual(saved);
    expect(
      (await employeeDashboard(actor, new Headers())).today.lateReason,
    ).toBe("Train delayed.");
    expect(
      await db.attendanceEvent.count({
        where: { attendanceId: checkedIn.id, type: "LATE_REASON_SUBMITTED" },
      }),
    ).toBe(1);
    await expect(
      saveLateReason(actor, { ...input, reason: "Different reason." }),
    ).rejects.toMatchObject({
      code: "LATE_REASON_ALREADY_SUBMITTED",
    });
    expect(
      (await db.attendance.findUniqueOrThrow({ where: { id: checkedIn.id } }))
        .lateReason,
    ).toBe("Train delayed.");
  });

  it("prevents another employee or revoked session from adding a late reason", async () => {
    const owner = await fixture();
    const other = await fixture();
    const checkedIn = await recordAttendance(
      owner,
      "CHECK_IN",
      {},
      new Headers(),
    );
    await db.attendance.update({
      where: { id: checkedIn.id },
      data: { lateMinutes: 20 },
    });
    const input = { attendanceId: checkedIn.id, reason: "Traffic." };
    await expect(saveLateReason(other, input)).rejects.toMatchObject({
      code: "ATTENDANCE_NOT_FOUND",
    });
    await db.session.delete({ where: { id: owner.sessionId } });
    await expect(saveLateReason(owner, input)).rejects.toMatchObject({
      code: "USER_NOT_AUTHORIZED",
    });
    expect(
      (await db.attendance.findUniqueOrThrow({ where: { id: checkedIn.id } }))
        .lateReason,
    ).toBeNull();
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

  it("shows check-in and checkout immediately on successive dashboard reads", async () => {
    const actor = await fixture();
    const before = await employeeDashboard(actor, new Headers());
    expect(before.today.checkInAt).toBeNull();

    const checkIn = await recordAttendance(
      actor,
      "CHECK_IN",
      {},
      new Headers(),
    );
    const checkedIn = await employeeDashboard(actor, new Headers());
    expect(checkedIn.today).toEqual(checkIn);
    expect(checkedIn.recent).toContainEqual(checkIn);
    await expect(
      recordAttendance(actor, "CHECK_IN", {}, new Headers()),
    ).rejects.toMatchObject({ code: "ALREADY_CHECKED_IN" });

    const checkOut = await recordAttendance(
      actor,
      "CHECK_OUT",
      {},
      new Headers(),
    );
    const checkedOut = await employeeDashboard(actor, new Headers());
    expect(checkedOut.today).toEqual(checkOut);
    expect(checkedOut.today.checkOutAt).toBeInstanceOf(Date);
    expect(checkedOut.today.workedMinutes).toBe(checkOut.workedMinutes);
    expect(checkedOut.recent).toContainEqual(checkOut);
    await expect(
      recordAttendance(actor, "CHECK_OUT", {}, new Headers()),
    ).rejects.toMatchObject({ code: "NOT_CHECKED_IN" });
  });

  it("rejects a deactivated employee after a previously authorized dashboard read", async () => {
    const actor = await fixture();
    await employeeDashboard(actor, new Headers());
    await db.user.update({
      where: { id: actor.id },
      data: { status: "INACTIVE" },
    });
    await expect(
      recordAttendance(actor, "CHECK_IN", {}, new Headers()),
    ).rejects.toMatchObject({ code: "USER_INACTIVE" });
    expect(
      await db.attendance.count({ where: { employeeId: actor.employee.id } }),
    ).toBe(0);
  });

  it("uses a changed office geofence after earlier dashboard and attendance reads", async () => {
    const actor = await fixture();
    await db.office.update({
      where: { id: actor.employee.officeId },
      data: { requireGeofence: true, geofenceRadiusMeters: 200 },
    });
    const evidence = {
      location: { latitude: 0.001, longitude: 0, accuracy: 10 },
    };
    await employeeDashboard(actor, new Headers());
    await recordAttendance(actor, "CHECK_IN", evidence, new Headers());

    await db.office.update({
      where: { id: actor.employee.officeId },
      data: { geofenceRadiusMeters: 50 },
    });
    await expect(
      recordAttendance(actor, "CHECK_OUT", evidence, new Headers()),
    ).rejects.toMatchObject({ code: "OUTSIDE_GEOFENCE" });
    expect(
      (await employeeDashboard(actor, new Headers())).today.checkOutAt,
    ).toBeNull();
  });

  it("verifies new location and accuracy evidence on every attendance attempt", async () => {
    const actor = await fixture();
    await db.office.update({
      where: { id: actor.employee.officeId },
      data: { requireGeofence: true },
    });
    const valid = { location: { latitude: 0, longitude: 0, accuracy: 10 } };
    await recordAttendance(actor, "CHECK_IN", valid, new Headers());
    await expect(
      recordAttendance(
        actor,
        "CHECK_OUT",
        {
          location: { latitude: 1, longitude: 1, accuracy: 10 },
        },
        new Headers(),
      ),
    ).rejects.toMatchObject({ code: "OUTSIDE_GEOFENCE" });
    await expect(
      recordAttendance(
        actor,
        "CHECK_OUT",
        {
          location: { latitude: 0, longitude: 0, accuracy: 100 },
        },
        new Headers(),
      ),
    ).rejects.toMatchObject({ code: "GPS_ACCURACY_TOO_LOW" });
    await expect(
      recordAttendance(actor, "CHECK_OUT", valid, new Headers()),
    ).resolves.toMatchObject({ checkOutAt: expect.any(Date) });
  });

  it("rechecks changed client IPs and revoked office networks after successful attendance", async () => {
    const actor = await fixture();
    await db.office.update({
      where: { id: actor.employee.officeId },
      data: { requireOfficeNetwork: true },
    });
    const network = await db.officeNetwork.create({
      data: {
        officeId: actor.employee.officeId,
        publicIpOrCidr: "192.0.2.0/24",
      },
    });
    expect(
      (await employeeDashboard(actor, officeHeaders())).network.verified,
    ).toBe(true);
    await recordAttendance(actor, "CHECK_IN", {}, officeHeaders());

    const outside = officeHeaders("198.51.100.10");
    expect((await employeeDashboard(actor, outside)).network.verified).toBe(
      false,
    );
    await expect(
      recordAttendance(actor, "CHECK_OUT", {}, outside),
    ).rejects.toMatchObject({ code: "WRONG_NETWORK" });

    await db.officeNetwork.update({
      where: { id: network.id },
      data: { active: false },
    });
    expect(
      (await employeeDashboard(actor, officeHeaders())).network.verified,
    ).toBe(false);
    await expect(
      recordAttendance(actor, "CHECK_OUT", {}, officeHeaders()),
    ).rejects.toMatchObject({ code: "WRONG_NETWORK" });
    expect(
      (await employeeDashboard(actor, officeHeaders())).today.checkOutAt,
    ).toBeNull();
  });

  it("requires newly enabled passkey policy after earlier unprotected attendance", async () => {
    const actor = await fixture();
    expect(
      (await employeeDashboard(actor, new Headers())).employee.office.policy
        .requireWebAuthn,
    ).toBe(false);
    await recordAttendance(actor, "CHECK_IN", {}, new Headers());
    await db.office.update({
      where: { id: actor.employee.officeId },
      data: { requireWebAuthn: true },
    });
    await expect(
      recordAttendance(actor, "CHECK_OUT", {}, new Headers()),
    ).rejects.toMatchObject({ code: "WEBAUTHN_REQUIRED" });
    const refreshed = await employeeDashboard(actor, new Headers());
    expect(refreshed.employee.office.policy.requireWebAuthn).toBe(true);
    expect(refreshed.today.checkOutAt).toBeNull();
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
