import { randomUUID } from "node:crypto";
import { hash } from "argon2";
import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
});
test.afterAll(async () => db.$disconnect());

test("password-only employee must register an approved passkey and verify both attendance actions", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const suffix = randomUUID();
  const password = "password-only browser passphrase";
  const user = await db.user.create({
    data: {
      email: `password-passkey-${suffix}@example.test`,
      name: "Passkey Browser",
      role: "EMPLOYEE",
      passwordHash: await hash(password),
      employee: {
        create: {
          employeeCode: suffix,
          office: {
            create: {
              name: `Passkey browser office ${suffix}`,
              address: "Test office",
              latitude: 0,
              longitude: 0,
              timezone: "UTC",
              requireWebAuthn: true,
              requireApprovedDevice: true,
              requireGeofence: false,
              requireOfficeNetwork: false,
            },
          },
          shifts: {
            create: {
              startDate: new Date("2020-01-01"),
              shift: {
                create: {
                  name: `Passkey browser shift ${suffix}`,
                  startTime: "00:00",
                  endTime: "23:59",
                  timezone: "UTC",
                  graceMinutes: 1440,
                },
              },
            },
          },
        },
      },
    },
    include: { employee: true },
  });
  const employeeId = user.employee!.id;
  // Real browser WebAuthn and server signature verification, with simulated
  // user presence/verification. This does not test a physical biometric sensor.
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  try {
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(user.email);
    await page
      .getByLabel("Application password", { exact: true })
      .fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/employee\/dashboard$/);
    const session = await context.request
      .get("/api/auth/session")
      .then((response) => response.json());
    expect(session.user.id).toBe(user.id);
    expect(await db.account.count({ where: { userId: user.id } })).toBe(0);
    expect(user.googleAccountId).toBeNull();

    await page.goto("/employee/devices");
    await page.getByLabel("Device name").fill("Virtual verified device");
    await page.getByRole("button", { name: "Register device" }).click();
    await expect(page.locator('.notice[role="status"]')).toContainText(
      "Device registered",
    );
    const credential = await db.webAuthnCredential.findFirstOrThrow({
      where: { employeeId },
    });
    expect(credential.approved).toBe(false);
    expect(credential.publicKey.byteLength).toBeGreaterThan(0);

    await page.goto("/employee/dashboard");
    await page.getByRole("button", { name: "Check in", exact: true }).click();
    await expect(page.locator('.notice[role="alert"]')).toContainText(
      "administrator approve",
    );
    expect(await db.attendance.count({ where: { employeeId } })).toBe(0);

    // Administrative approval is fixture setup; registration and attendance
    // still use the real authenticated UI, API, challenge and signature flow.
    await db.webAuthnCredential.update({
      where: { id: credential.id },
      data: { approved: true },
    });
    await page.reload();
    await page.getByRole("button", { name: "Check in", exact: true }).click();
    await expect(page.locator('.notice[role="status"]')).toContainText(
      "You’re checked in",
    );
    await page.getByRole("button", { name: "Check out", exact: true }).click();
    await expect(page.locator('.notice[role="status"]')).toContainText(
      "You’re checked out",
    );

    const attendance = await db.attendance.findFirstOrThrow({
      where: { employeeId },
    });
    expect(attendance.checkInAt).not.toBeNull();
    expect(attendance.checkOutAt).not.toBeNull();
    expect(attendance.checkInCredentialId).toBe(credential.id);
    expect(attendance.checkOutCredentialId).toBe(credential.id);
    const challenges = await db.webAuthnChallenge.findMany({
      where: { employeeId },
    });
    expect(challenges.map((item) => item.purpose).sort()).toEqual([
      "CHECK_IN",
      "CHECK_OUT",
      "REGISTRATION",
    ]);
    expect(
      challenges.every(
        (item) => item.usedAt && item.sessionId === session.sessionId,
      ),
    ).toBe(true);
    expect(
      (
        await db.webAuthnCredential.findUniqueOrThrow({
          where: { id: credential.id },
        })
      ).counter,
    ).toBeGreaterThan(credential.counter);
    await page.screenshot({
      path: "test-results/password-passkey-attendance.png",
      fullPage: true,
    });
  } finally {
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await cdp.detach();
  }
});
