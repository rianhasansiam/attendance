import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
});
const origin = "http://localhost:3100";

// This creates an ordinary Auth.js database session only in the isolated test
// database required by playwright.config.ts. There is no application bypass.
async function fixture(context: BrowserContext) {
  const marker = `State-${randomUUID()}`;
  const user = await db.user.create({
    data: {
      name: marker,
      email: `${marker.toLowerCase()}@example.test`,
      role: "ADMIN",
      googleAccountId: randomUUID(),
      // An administrator without an Employee profile must remain supported.
    },
  });
  const token = randomUUID();
  const session = await db.session.create({
    data: {
      userId: user.id,
      sessionToken: token,
      expires: new Date(Date.now() + 3_600_000),
    },
  });
  const department = await db.department.create({ data: { name: marker } });
  await context.addCookies([
    {
      name: "authjs.session-token",
      value: token,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return {
    user,
    session,
    department,
    marker,
    path: `/admin/departments?q=${encodeURIComponent(marker)}`,
  };
}

test.afterAll(async () => db.$disconnect());

test("Auth.js logout clears both tabs and a delayed old read cannot reveal private data", async ({
  page,
  context,
}) => {
  const data = await fixture(context);
  const second = await context.newPage();
  await page.goto(data.path);
  await second.goto(data.path);
  await expect(
    page.getByRole("cell", { name: data.marker, exact: true }),
  ).toBeVisible();
  await expect(
    second.getByRole("cell", { name: data.marker, exact: true }),
  ).toBeVisible();

  let release!: () => void;
  let observed!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    observed = resolve;
  });
  await second.route("**/api/admin/departments?*", async (route) => {
    const response = await route.fetch();
    observed();
    await delayed;
    // Logout may already have discarded the document and aborted this request.
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await second.getByRole("button", { name: "Refresh", exact: true }).click();
    await requested;
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login/);
    release();
    await expect(second).toHaveURL(/\/login/);
    await expect(
      second.getByRole("cell", { name: data.marker, exact: true }),
    ).toHaveCount(0);
    await expect(
      second.getByRole("button", { name: "Continue with Google" }),
    ).toBeVisible();
    expect(await db.session.count({ where: { id: data.session.id } })).toBe(0);
  } finally {
    release();
    await second.close();
  }
});

test("returning to a retained management route refreshes its query and keeps URL filters", async ({
  page,
  context,
}) => {
  const data = await fixture(context);
  await page.goto(data.path);
  await expect(
    page.getByRole("cell", { name: data.marker, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Offices", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Offices", exact: true }),
  ).toBeVisible();
  const renamed = `${data.marker}-updated`;
  await db.department.update({
    where: { id: data.department.id },
    data: { name: renamed },
  });
  const refreshed = page.waitForResponse(
    (response) =>
      response.url().includes("/api/admin/departments?") && response.ok(),
  );
  await page.goBack();
  await refreshed;
  await expect(
    page.getByRole("textbox", { name: "Search departments" }),
  ).toHaveValue(data.marker);
  await expect(
    page.getByRole("cell", { name: renamed, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: data.marker, exact: true }),
  ).toHaveCount(0);
});

test("a revoked database session is detected by the next protected query and clears cached records", async ({
  page,
  context,
}) => {
  const data = await fixture(context);
  await page.goto(data.path);
  await expect(
    page.getByRole("cell", { name: data.marker, exact: true }),
  ).toBeVisible();
  let reportStatus!: (status: number) => void;
  const denied = new Promise<number>((resolve) => {
    reportStatus = resolve;
  });
  // Revoke at the next actual resource request. Otherwise the concurrent
  // Auth.js mount recheck may correctly redirect before Refresh can be clicked.
  await page.route("**/api/admin/departments?*", async (route) => {
    await db.session.deleteMany({ where: { id: data.session.id } });
    const response = await route.fetch();
    reportStatus(response.status());
    await route.fulfill({ response }).catch(() => {});
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  expect(await denied).toBe(401);
  await expect(page).toHaveURL(/\/login/);
  await expect(
    page.getByRole("cell", { name: data.marker, exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Continue with Google" }),
  ).toBeVisible();
});
