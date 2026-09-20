import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext } from "@playwright/test";
import { PrismaClient, type Role } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
const database = process.env.TEST_DATABASE_URL!;
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: database }),
});

async function session(context: BrowserContext, role: Role = "EMPLOYEE") {
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
  const shift = await db.shift.create({
    data: {
      name: `Browser shift ${suffix}`,
      startTime: "00:00",
      endTime: "23:59",
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

test("super administrator manages departments and downloads both report formats", async ({
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
  await expect(page.getByRole("status")).toContainText("saved");
  await page.getByLabel("Search departments").fill(name);
  await expect(page.getByRole("cell", { name, exact: true })).toBeVisible();
  for (const format of ["csv", "xlsx"]) {
    const response = await context.request.get(
      `/api/admin/reports?format=${format}`,
    );
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-disposition"]).toContain(`.${format}`);
    expect((await response.body()).byteLength).toBeGreaterThan(50);
  }
  const crossOrigin = await context.request.post("/api/admin/departments", {
    data: { name: "Forbidden cross-site" },
    headers: { origin: "https://untrusted.example" },
  });
  expect(crossOrigin.status()).toBe(403);
});
