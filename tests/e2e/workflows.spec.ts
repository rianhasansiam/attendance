import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext } from "@playwright/test";
import { PrismaClient, type Role } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
const database = process.env.TEST_DATABASE_URL!;
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: database }),
});

async function session(
  context: BrowserContext,
  role: Role = "EMPLOYEE",
  arrival: "on-time" | "late" = "on-time",
) {
  const suffix = randomUUID();
  const office = await db.office.create({
    data: {
      name: `Browser office ${suffix}`,
      address: "Test office",
      latitude: 23.8,
      longitude: 90.4,
      requireWebAuthn: false,
      requireApprovedDevice: false,
      requireGeofence: false,
      requireOfficeNetwork: false,
      timezone: "UTC",
    },
  });
  const now = Date.now();
  const shift = await db.shift.create({
    data: {
      name: `Browser shift ${suffix}`,
      // Relative boundaries also cover a late arrival just after midnight.
      startTime:
        arrival === "late"
          ? new Date(now - 30 * 60_000).toISOString().slice(11, 16)
          : "00:00",
      endTime:
        arrival === "late"
          ? new Date(now + 8 * 60 * 60_000).toISOString().slice(11, 16)
          : "23:59",
      graceMinutes: arrival === "late" ? 15 : 1440,
      timezone: "UTC",
    },
  });
  const user = await db.user.create({
    data: {
      email: `browser-${suffix}@example.test`,
      name: "Browser Tester",
      role,
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
      accounts: {
        create: { type: "oidc", provider: "google", providerAccountId: suffix },
      },
    },
    include: { employee: true },
  });
  const token = randomUUID();
  await db.session.create({
    data: {
      userId: user.id,
      sessionToken: token,
      expires: new Date(Date.now() + 3_600_000),
    },
  });
  await context.addCookies([
    {
      name: "authjs.session-token",
      value: token,
      url: "http://localhost:3100",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return { user, office, shift, token };
}
test.afterAll(async () => {
  await db.$disconnect();
});

test("Google-only login and unauthenticated API denial", async ({
  page,
  request,
}) => {
  await page.goto("/login");
  await expect(
    page.getByRole("button", { name: "Continue with Google" }),
  ).toBeVisible();
  await expect(
    page.locator('input[type="password"], input[type="email"]'),
  ).toHaveCount(0);
  const response = await request.get("/api/admin/dashboard");
  expect(response.status()).toBe(401);
  expect((await response.json()).error.code).toBe("UNAUTHENTICATED");
  await page.screenshot({ path: "test-results/login.png", fullPage: true });
});

test("employee can check in and out, request leave, and cannot access admin", async ({
  page,
  context,
}) => {
  const fixture = await session(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/employee/dashboard");
  await expect(
    page.getByRole("heading", { name: "Hello, Browser." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check in", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "You’re checked in" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check out", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("dialog", { name: "Reason for late attendance" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "test-results/employee-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Check out", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "You’re checked out" }),
  ).toBeVisible();
  const record = await db.attendance.findFirstOrThrow({
    where: { employeeId: fixture.user.employee!.id },
  });
  expect(record.checkInAt).not.toBeNull();
  expect(record.checkOutAt).not.toBeNull();
  expect(record.lateMinutes).toBe(0);
  expect(record.lateReason).toBeNull();
  const forbidden = await context.request.get("/api/admin/dashboard");
  expect(forbidden.status()).toBe(403);
  const sessionResponse = await context.request.get("/api/auth/session");
  const exposed = await sessionResponse.text();
  expect(exposed).not.toContain(fixture.token);
  expect(exposed).not.toContain("sessionToken");
  expect(exposed).not.toContain("googleAccountId");
  await page.goto("/employee/leaves");
  await page.getByRole("button", { name: "Request leave" }).click();
  await page.getByLabel("First day").fill("2027-01-11");
  await page.getByLabel("Last day").fill("2027-01-12");
  await page.getByLabel("Reason").fill("Planned family time");
  await page.getByRole("button", { name: "Submit request" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Leave request submitted" }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Planned family time" }),
  ).toBeVisible();
  await db.user.update({
    where: { id: fixture.user.id },
    data: { status: "SUSPENDED" },
  });
  expect(
    (await context.request.get("/api/attendance/me")).status(),
  ).toBeGreaterThanOrEqual(401);
});

test("late check-in asks for a reason and preserves the draft when saving fails", async ({
  page,
  context,
}) => {
  const fixture = await session(context, "EMPLOYEE", "late");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/employee/dashboard");
  await page.getByRole("button", { name: "Check in", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Reason for late attendance",
  });
  await expect(dialog).toBeVisible();
  const checkedIn = await db.attendance.findFirstOrThrow({
    where: { employeeId: fixture.user.employee!.id },
  });
  expect(checkedIn.checkInAt).not.toBeNull();
  expect(checkedIn.lateMinutes).toBeGreaterThan(15);
  expect(checkedIn.lateReason).toBeNull();

  let attempts = 0;
  await page.route("**/api/attendance/late-reason", async (route) => {
    attempts += 1;
    expect(route.request().postDataJSON()).toEqual({
      attendanceId: checkedIn.id,
      reason: "Train service was delayed.",
    });
    if (attempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "UNAVAILABLE",
            message: "Unable to save right now. Please try again.",
          },
        }),
      });
      return;
    }
    await route.continue();
  });
  await dialog
    .getByLabel("Reason", { exact: true })
    .fill("Train service was delayed.");
  await page.screenshot({
    path: "test-results/late-reason-mobile.png",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Submit reason" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Unable to save right now",
  );
  await expect(dialog.getByLabel("Reason", { exact: true })).toHaveValue(
    "Train service was delayed.",
  );
  await expect(dialog.getByLabel("Reason", { exact: true })).toBeFocused();
  expect(
    (await db.attendance.findUniqueOrThrow({ where: { id: checkedIn.id } }))
      .lateReason,
  ).toBeNull();

  await dialog.getByRole("button", { name: "Submit reason" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({
      hasText: "Your late attendance reason has been saved.",
    }),
  ).toBeVisible();
  expect(attempts).toBe(2);
  const saved = await db.attendance.findUniqueOrThrow({
    where: { id: checkedIn.id },
  });
  expect(saved.lateReason).toBe("Train service was delayed.");
  expect(saved.checkInAt).toEqual(checkedIn.checkInAt);
  expect(
    await db.attendance.count({
      where: { employeeId: fixture.user.employee!.id },
    }),
  ).toBe(1);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Check out", exact: true }),
  ).toBeEnabled();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add late reason" }),
  ).toHaveCount(0);
  await page.goto("/employee/history");
  await expect(
    page.getByRole("columnheader", { name: "Late reason", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Train service was delayed.", exact: true }),
  ).toBeVisible();
});

test("an unfinished late reason can be reopened and survives reload after checking out", async ({
  page,
  context,
}) => {
  const fixture = await session(context, "EMPLOYEE", "late");
  await page.goto("/employee/dashboard");
  await page.getByRole("button", { name: "Check in", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Reason for late attendance",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Later", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Add late reason" }).click();
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Later", exact: true }).click();
  await page.getByRole("button", { name: "Check out", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "You’re checked out" }),
  ).toBeVisible();
  const checkedOut = await db.attendance.findFirstOrThrow({
    where: { employeeId: fixture.user.employee!.id },
  });
  expect(checkedOut.status).toBe("HALF_DAY");
  expect(checkedOut.lateMinutes).toBeGreaterThan(15);
  expect(checkedOut.lateReason).toBeNull();
  await page.reload();
  await expect(dialog).toBeVisible();
  await dialog
    .getByLabel("Reason", { exact: true })
    .fill("Road closure on my commute.");
  await dialog.getByRole("button", { name: "Submit reason" }).click();
  await expect(dialog).toHaveCount(0);
  const saved = await db.attendance.findUniqueOrThrow({
    where: { id: checkedOut.id },
  });
  expect(saved.status).toBe("HALF_DAY");
  expect(saved.checkOutAt).toEqual(checkedOut.checkOutAt);
  expect(saved.lateReason).toBe("Road closure on my commute.");
  expect(
    await db.attendance.count({
      where: { employeeId: fixture.user.employee!.id },
    }),
  ).toBe(1);
});

test("refresh clears a late reason reminder after the reason is saved in another tab", async ({
  page,
  context,
}) => {
  const fixture = await session(context, "EMPLOYEE", "late");
  await page.goto("/employee/dashboard");
  await page.getByRole("button", { name: "Check in", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Reason for late attendance",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Later", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Add late reason" }),
  ).toBeVisible();
  const attendance = await db.attendance.findFirstOrThrow({
    where: { employeeId: fixture.user.employee!.id },
  });
  const saved = await context.request.post("/api/attendance/late-reason", {
    data: {
      attendanceId: attendance.id,
      reason: "Saved from my other browser tab.",
    },
    headers: { origin: "http://localhost:3100" },
  });
  expect(saved.ok()).toBe(true);

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("cell", {
      name: "Saved from my other browser tab.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add late reason" }),
  ).toHaveCount(0);
});

test("super administrator manages departments and downloads a PDF report", async ({
  page,
  context,
}) => {
  await session(context, "SUPER_ADMIN");
  await page.goto("/admin/dashboard");
  await expect(page.locator("h1")).toBeVisible();
  await expect(
    page.getByText("Total employees", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".notice.error")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/admin-dashboard.png",
    fullPage: true,
  });
  await page.goto("/admin/departments");
  await page.getByRole("button", { name: "Add department" }).click();
  const name = `Browser department ${randomUUID()}`;
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: false })
    .fill(name);
  await page.getByRole("dialog").getByRole("button", { name: /save/i }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Your changes have been saved." }),
  ).toBeVisible();
  await page.getByLabel("Search departments").fill(name);
  await expect(page.getByRole("cell", { name, exact: true })).toBeVisible();
  const response = await context.request.get("/api/admin/reports?format=pdf");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toBe("application/pdf");
  expect(response.headers()["content-disposition"]).toContain(".pdf");
  const pdf = await response.body();
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  expect(pdf.byteLength).toBeGreaterThan(1000);
  const crossOrigin = await context.request.post("/api/admin/departments", {
    data: { name: "Forbidden cross-site" },
    headers: { origin: "https://untrusted.example" },
  });
  expect(crossOrigin.status()).toBe(403);
});

test.describe("attendance correction permissions", () => {
  test.use({ timezoneId: "UTC" });

  async function recordedAttendance(context: BrowserContext) {
    const target = await session(context);
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const record = await db.attendance.create({
      data: {
        employeeId: target.user.employee!.id,
        officeId: target.office.id,
        shiftId: target.shift.id,
        attendanceDate: new Date(`${day}T00:00:00Z`),
        checkInAt: new Date(`${day}T09:00:00Z`),
        checkOutAt: new Date(`${day}T17:00:00Z`),
        status: "PRESENT",
        workedMinutes: 480,
      },
    });
    return { target, record, day };
  }

  for (const role of ["ADMIN", "EMPLOYEE"] as const) {
    test(`${role} cannot create or edit another employee's attendance`, async ({
      page,
      context,
    }) => {
      const { target, record, day } = await recordedAttendance(context);
      await session(context, role);
      if (role === "ADMIN") {
        const records = await context.request.get(
          `/api/admin/attendance?employeeId=${target.user.employee!.id}&from=${day}&to=${day}`,
        );
        expect(records.ok()).toBe(true);
        expect((await records.json()).data.items).toEqual([
          expect.objectContaining({ id: record.id, status: "PRESENT" }),
        ]);
        await page.goto(
          `/admin/attendance?employeeId=${target.user.employee!.id}`,
        );
        await expect(
          page
            .getByRole("cell", { name: target.office.name, exact: true })
            .first(),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Correct attendance", exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("columnheader", { name: "Actions", exact: true }),
        ).toHaveCount(0);
      }

      const payload = {
        checkInAt: null,
        checkOutAt: null,
        status: "ABSENT",
        reason: "An unauthorized attendance correction.",
      };
      const create = await context.request.post("/api/admin/attendance", {
        data: {
          ...payload,
          employeeId: target.user.employee!.id,
          attendanceDate: new Date(Date.now() - 2 * 86_400_000)
            .toISOString()
            .slice(0, 10),
        },
        headers: { origin: "http://localhost:3100" },
      });
      expect(create.status()).toBe(403);
      const update = await context.request.patch(
        `/api/admin/attendance/${record.id}`,
        {
          data: payload,
          headers: { origin: "http://localhost:3100" },
        },
      );
      expect(update.status()).toBe(403);
      expect(
        await db.attendance.findUniqueOrThrow({ where: { id: record.id } }),
      ).toEqual(record);
      expect(
        await db.attendance.count({
          where: { employeeId: target.user.employee!.id },
        }),
      ).toBe(1);
      expect(
        await db.auditLog.count({ where: { resourceId: record.id } }),
      ).toBe(0);
    });
  }

  test("SUPER_ADMIN can correct another employee's attendance with a required audit reason", async ({
    page,
    context,
  }) => {
    const { target, record, day } = await recordedAttendance(context);
    const actor = await session(context, "SUPER_ADMIN");
    await page.goto(`/admin/attendance?employeeId=${target.user.employee!.id}`);
    await page.getByLabel("From date", { exact: true }).fill(day);
    await page.getByLabel("To date", { exact: true }).fill(day);
    await page
      .getByRole("button", { name: "Apply filters", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Correct attendance", exact: true }),
    ).toHaveCount(1);
    await page
      .getByRole("button", { name: "Correct attendance", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Correct attendance" });
    await dialog.getByLabel("Check in", { exact: true }).fill(`${day}T09:30`);
    await dialog
      .getByRole("button", { name: "Save correction", exact: true })
      .click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Reason for correction")).toBeFocused();
    expect(
      (await db.attendance.findUniqueOrThrow({ where: { id: record.id } }))
        .checkInAt,
    ).toEqual(record.checkInAt);

    const reason = "Manager verified the employee's arrival.";
    await dialog.getByLabel("Reason for correction").fill(reason);
    await dialog
      .getByRole("button", { name: "Save correction", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({
        hasText:
          "Attendance updated. The correction has been added to the audit log.",
      }),
    ).toBeVisible();
    const corrected = await db.attendance.findUniqueOrThrow({
      where: { id: record.id },
    });
    expect(corrected.employeeId).toBe(target.user.employee!.id);
    expect(corrected.checkInAt).toEqual(new Date(`${day}T09:30:00Z`));
    expect(corrected.workedMinutes).toBe(450);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { resourceId: record.id, action: "ATTENDANCE_CORRECTED" },
    });
    expect(audit.actorId).toBe(actor.user.id);
    expect(audit.previousState).toMatchObject({
      checkInAt: record.checkInAt!.toISOString(),
    });
    expect(audit.newState).toMatchObject({
      checkInAt: corrected.checkInAt!.toISOString(),
      reason,
    });
    expect(
      await db.attendanceEvent.findFirstOrThrow({
        where: { attendanceId: record.id, type: "ADMIN_CORRECTION" },
      }),
    ).toMatchObject({ reason, metadata: { actorId: actor.user.id } });
  });
});

// Exercise the real Next cache, not a mock of cacheTag/cacheLife.
test("display lookup cache expires on writes and never authorizes an inactive user", async ({
  context,
}) => {
  const fixture = await session(context, "SUPER_ADMIN");
  for (const resource of ["departments", "offices", "shifts"] as const) {
    const name = `Cache ${resource} ${randomUUID()}`;
    const payload =
      resource === "departments"
        ? { name }
        : resource === "offices"
          ? {
              name,
              address: "Cache test",
              latitude: 0,
              longitude: 0,
              geofenceRadiusMeters: 100,
              timezone: "UTC",
            }
          : { name, startTime: "09:00", endTime: "17:00", timezone: "UTC" };
    const created = await context.request.post(`/api/admin/${resource}`, {
      data: payload,
      headers: { origin: "http://localhost:3100" },
    });
    expect(created.ok()).toBe(true);
    const id = (await created.json()).data.id as string;
    const url = `/api/admin/lookups/${resource}?pageSize=100`;
    const warm = await context.request.get(url);
    expect(warm.ok()).toBe(true);
    expect(warm.headers()["cache-control"]).toBe("no-store");
    const labels = (await warm.json()).data.items as {
      id: string;
      name: string;
    }[];
    expect(labels.find((row) => row.id === id)?.name).toBe(name);
    expect(Object.keys(labels.find((row) => row.id === id)!).sort()).toEqual([
      "id",
      "name",
    ]);
    const changed = `${name} renamed`;
    // Direct fixture writes bypass invalidation, proving the next request
    // actually reuses Next's server cache rather than simply querying again.
    if (resource === "departments")
      await db.department.update({ where: { id }, data: { name: changed } });
    else if (resource === "offices")
      await db.office.update({ where: { id }, data: { name: changed } });
    else await db.shift.update({ where: { id }, data: { name: changed } });
    const cached = await context.request.get(url);
    expect(
      (await cached.json()).data.items.find(
        (row: { id: string }) => row.id === id,
      ).name,
    ).toBe(name);
    const updated = await context.request.patch(
      `/api/admin/${resource}/${id}`,
      { data: { name: changed }, headers: { origin: "http://localhost:3100" } },
    );
    expect(updated.ok()).toBe(true);
    const fresh = await context.request.get(url);
    expect(
      (await fresh.json()).data.items.find(
        (row: { id: string }) => row.id === id,
      ).name,
    ).toBe(changed);
  }
  await db.user.update({
    where: { id: fixture.user.id },
    data: { status: "INACTIVE" },
  });
  expect(
    (
      await context.request.get("/api/admin/lookups/offices?pageSize=100")
    ).status(),
  ).toBeGreaterThanOrEqual(401);
});

test("returning to employee dashboard refreshes attendance and profile renders without an API waterfall", async ({
  page,
  context,
}) => {
  await session(context);
  const profileRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/employee/profile"))
      profileRequests.push(request.url());
  });
  await page.goto("/employee/dashboard");
  await expect(
    page.getByRole("button", { name: "Check in", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("link", { name: "My profile", exact: true })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "My profile" })).toBeVisible();
  expect(profileRequests).toHaveLength(0);
  const checkedIn = await context.request.post("/api/attendance/check-in", {
    data: {},
    headers: { origin: "http://localhost:3100" },
  });
  expect(checkedIn.ok()).toBe(true);
  const response = page.waitForResponse(
    (response) =>
      response.url().includes("/api/attendance/me") && response.ok(),
  );
  await page.getByRole("link", { name: "My day", exact: true }).first().click();
  await response;
  await expect(
    page.getByRole("button", { name: "Check out", exact: true }),
  ).toBeEnabled();
});

test("device history is paginated without exposing credential material", async ({
  page,
  context,
}) => {
  const fixture = await session(context);
  const prefix = randomUUID();
  await db.webAuthnCredential.createMany({
    data: Array.from({ length: 31 }, (_, i) => ({
      id: `${prefix}-${String(i).padStart(2, "0")}`,
      employeeId: fixture.user.employee!.id,
      name: `Past device ${i}`,
      credentialId: `private-${prefix}-${i}`,
      publicKey: new Uint8Array([1, 2, 3]),
      transports: [],
      deviceType: "singleDevice",
      createdAt: new Date("2025-01-01T00:00:00Z"),
      revokedAt: i ? new Date("2025-02-01T00:00:00Z") : null,
    })),
  });
  const first = await context.request.get("/api/webauthn/devices?page=1");
  const firstText = await first.text();
  expect(firstText).not.toContain("credentialId");
  expect(firstText).not.toContain("publicKey");
  expect(firstText).not.toContain("counter");
  const a = JSON.parse(firstText).data;
  const b = (
    await (await context.request.get("/api/webauthn/devices?page=2")).json()
  ).data;
  expect(a.total).toBe(31);
  expect(a.items).toHaveLength(25);
  expect(b.items).toHaveLength(6);
  expect(new Set([...a.items, ...b.items].map((row) => row.id)).size).toBe(31);
  await page.goto("/employee/devices");
  await expect(page.locator(".device-row")).toHaveCount(25);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator(".device-row")).toHaveCount(6);
});
