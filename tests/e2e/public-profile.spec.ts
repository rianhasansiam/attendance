import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { PrismaClient, type Role, type UserStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { testSessionCookie } from "./session-cookie";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
});
const origin = "http://localhost:3100";
const publicDetails = {
  designation: "Operations officer",
  phone: "+880 1700 123456",
  bloodGroup: "O+",
  publicDepartment: "Operations",
  homeAddress: "House 12, Dhaka",
  dateOfBirth: new Date("1995-01-15T00:00:00.000Z"),
};

test.afterAll(async () => db.$disconnect());

async function profileFixture({
  role = "EMPLOYEE",
  status = "ACTIVE",
  name = "Public profile colleague",
  image = null,
  listedDetails = true,
}: {
  role?: Role;
  status?: UserStatus;
  name?: string | null;
  image?: string | null;
  listedDetails?: boolean;
} = {}) {
  const key = randomUUID();
  const privateValues = {
    email: `private-profile-${key}@example.test`,
    passwordHash: `private-password-hash-${key}`,
    googleAccountId: `private-google-account-${key}`,
    employeeCode: `private-employee-code-${key}`,
    accessToken: `private-access-token-${key}`,
    providerAccountId: `private-provider-account-${key}`,
    sessionToken: `private-session-token-${key}`,
    address: `Private office street ${key}`,
    department: `Private internal department ${key}`,
    office: `Private office ${key}`,
  };
  const user = await db.user.create({
    data: {
      name,
      email: privateValues.email,
      role,
      status,
      image,
      ...(listedDetails ? publicDetails : {}),
      passwordHash: privateValues.passwordHash,
      googleAccountId: privateValues.googleAccountId,
      accounts: {
        create: {
          provider: "google",
          type: "oidc",
          providerAccountId: privateValues.providerAccountId,
          access_token: privateValues.accessToken,
        },
      },
      sessions: {
        create: {
          sessionToken: privateValues.sessionToken,
          expires: new Date(Date.now() + 3_600_000),
        },
      },
      ...(role === "EMPLOYEE" || role === "MANAGE_DRIVER"
        ? {
            employee: {
              create: {
                employeeCode: privateValues.employeeCode,
                department: {
                  create: { name: privateValues.department },
                },
                office: {
                  create: {
                    name: privateValues.office,
                    address: privateValues.address,
                    latitude: 23.123456,
                    longitude: 90.123456,
                  },
                },
              },
            },
          }
        : {}),
    },
    include: {
      employee: { include: { department: true, office: true } },
    },
  });
  return { user, privateValues };
}

async function signIn(context: BrowserContext, role: Role) {
  const fixture = await profileFixture({ role });
  await context.addCookies([
    {
      name: "authjs.session-token",
      value: await testSessionCookie(db, fixture.privateValues.sessionToken),
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return fixture;
}

async function expectPublicDetails(
  page: Page,
  details: Record<string, string>,
) {
  for (const [label, value] of Object.entries(details)) {
    const detail = page
      .locator("dl > div")
      .filter({ has: page.getByText(label, { exact: true }) });
    await expect(detail.locator("dd")).toHaveText(value);
  }
}

test("an anonymous visitor sees the public employee details without private data in HTML or RSC", async ({
  page,
  context,
}) => {
  const { user, privateValues } = await profileFixture();
  const path = `/profile/${user.profileSlug}`;
  const response = await page.goto(path);
  await expect(page).toHaveURL(`${origin}/profile/${user.profileSlug}`);
  await expect(
    page.getByRole("heading", { level: 1, name: user.name!, exact: true }),
  ).toBeVisible();
  await expectPublicDetails(page, {
    Designation: publicDetails.designation,
    Phone: publicDetails.phone,
    "Blood group": publicDetails.bloodGroup,
    Department: publicDetails.publicDepartment,
    "Home address": publicDetails.homeAddress,
    "Date of birth": "15 January 1995",
  });
  await expect(page.locator("dt")).toHaveCount(6);
  await expect(
    page.getByRole("link", { name: "Edit public profile", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  expect(
    (await context.cookies()).filter((cookie) =>
      /session-token/.test(cookie.name),
    ),
  ).toHaveLength(0);

  const html = await response!.text();
  const rscResponse = await context.request.get(path, {
    headers: { RSC: "1" },
  });
  expect(rscResponse.headers()["content-type"]).toContain("text/x-component");
  const rsc = await rscResponse.text();
  expect(rsc).toContain(user.name!);
  for (const privateValue of [
    ...Object.values(privateValues),
    user.employee!.id,
    "23.123456",
    "90.123456",
  ]) {
    expect(html).not.toContain(privateValue);
    expect(rsc).not.toContain(privateValue);
  }
  await page.screenshot({
    path: "/tmp/public-profile-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { level: 1, name: user.name! }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/public-profile-mobile.png",
    fullPage: true,
  });
});

test("a legacy ID link redirects to the name-based profile URL", async ({
  page,
}) => {
  const { user } = await profileFixture({ name: "Rian Hasan Siam " });
  expect(user.profileSlug).toBe("rian_hasan_siam");
  await page.goto(`/profile/${user.id}`);
  await expect(page).toHaveURL(`${origin}/profile/rian_hasan_siam`);
  await expect(
    page.getByRole("heading", { name: "Rian Hasan Siam", exact: true }),
  ).toBeVisible();
});

test("an anonymous visitor can view an administrator without an employee record", async ({
  page,
}) => {
  const { user } = await profileFixture({
    role: "ADMIN",
    name: "Public administrator",
    listedDetails: false,
  });
  await page.goto(`/profile/${user.id}`);
  await expect(
    page.getByRole("heading", { level: 1, name: user.name! }),
  ).toBeVisible();
  await expect(
    page.locator("dd").filter({ hasText: /^Not listed$/ }),
  ).toHaveCount(6);
});

for (const status of ["INACTIVE", "SUSPENDED"] as const) {
  test(`${status} users are unavailable to anonymous visitors`, async ({
    page,
  }) => {
    const { user } = await profileFixture({
      status,
      name: `Private ${status} colleague`,
    });
    const response = await page.goto(`/profile/${user.id}`);
    await expect(
      page.getByRole("heading", { name: "Profile unavailable", exact: true }),
    ).toBeVisible();
    await expect(page.getByText(user.name!, { exact: true })).toHaveCount(0);
    expect(await response!.text()).not.toContain(user.name!);
    // Streamed notFound() metadata may appear in both the head and body.
    await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute(
      "content",
      /noindex/,
    );
  });
}

test("deleted and unknown users have the same unavailable page", async ({
  page,
}) => {
  const { user } = await profileFixture({
    role: "ADMIN",
    name: "Deleted colleague",
  });
  await db.user.delete({ where: { id: user.id } });
  for (const id of [user.id, `missing-${randomUUID()}`]) {
    await page.goto(`/profile/${id}`);
    await expect(
      page.getByRole("heading", { name: "Profile unavailable", exact: true }),
    ).toBeVisible();
    await expect(page.getByText(user.name!, { exact: true })).toHaveCount(0);
  }
});

test("deactivating a visible user immediately removes their public profile", async ({
  page,
}) => {
  const { user } = await profileFixture({ name: "Soon inactive colleague" });
  await page.goto(`/profile/${user.id}`);
  await expect(
    page.getByRole("heading", { level: 1, name: user.name! }),
  ).toBeVisible();
  await db.user.update({
    where: { id: user.id },
    data: { status: "INACTIVE" },
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Profile unavailable", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(user.name!, { exact: true })).toHaveCount(0);
});

test("missing names and untrusted images use neutral public fallbacks", async ({
  page,
}) => {
  const image = "https://untrusted.example.test/private-tracking-image";
  const { user, privateValues } = await profileFixture({ name: null, image });
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://untrusted.example.test")) {
      externalRequests.push(request.url());
    }
  });
  const response = await page.goto(`/profile/${user.id}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Team member", exact: true }),
  ).toBeVisible();
  const html = await response!.text();
  expect(html).not.toContain(privateValues.email);
  expect(html).not.toContain(image);
  expect(externalRequests).toEqual([]);
});

test("Super Admin edits every public detail and anonymous visitors see the saved profile", async ({
  page,
  context,
  browser,
}) => {
  await signIn(context, "SUPER_ADMIN");
  const { user, privateValues } = await profileFixture();
  const path = `/profile/${user.id}`;
  const apiPath = `/api/admin/users/${user.id}/public-profile`;
  const changes = {
    name: "Updated public colleague",
    designation: "Senior operations officer",
    phone: "+880 1800 654321",
    bloodGroup: "AB-",
    publicDepartment: "Customer services",
    homeAddress: "Flat 5, House 42\nUttara, Dhaka",
    dateOfBirth: "1992-02-29",
  };
  const anonymousContext = await browser.newContext();
  try {
    const anonymousPage = await anonymousContext.newPage();
    await anonymousPage.goto(`${origin}${path}`);
    await expect(
      anonymousPage.getByRole("heading", { level: 1, name: user.name! }),
    ).toBeVisible();

    await page.goto(`/admin/users/${user.id}/profile`);
    await expect(page).toHaveURL(
      new RegExp(`/admin/users/${user.id}/profile$`),
    );
    await page.getByLabel("Name *", { exact: true }).fill(changes.name);
    await page
      .getByLabel("Designation", { exact: true })
      .fill(changes.designation);
    await page.getByLabel("Phone", { exact: true }).fill(changes.phone);
    await page
      .getByLabel("Blood group", { exact: true })
      .selectOption(changes.bloodGroup);
    await page
      .getByLabel("Department", { exact: true })
      .fill(changes.publicDepartment);
    await page
      .getByLabel("Home address", { exact: true })
      .fill(changes.homeAddress);
    await page
      .getByLabel("Date of birth", { exact: true })
      .fill(changes.dateOfBirth);
    await page.screenshot({
      path: "/tmp/public-profile-editor.png",
      fullPage: true,
    });
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === apiPath &&
        response.request().method() === "PATCH",
    );
    await page
      .getByRole("button", { name: "Save public profile", exact: true })
      .click();
    const response = await responsePromise;
    expect(response.ok()).toBe(true);
    const responseText = await response.text();
    for (const value of Object.values(privateValues)) {
      expect(responseText).not.toContain(value);
    }
    await expect(
      page.getByText("Public profile saved.", { exact: true }).first(),
    ).toBeVisible();
    const persisted = await db.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(persisted).toMatchObject({
      ...changes,
      dateOfBirth: new Date("1992-02-29T00:00:00.000Z"),
      email: privateValues.email,
      passwordHash: privateValues.passwordHash,
      googleAccountId: privateValues.googleAccountId,
    });

    await anonymousPage.reload();
    await expect(
      anonymousPage.getByRole("heading", {
        level: 1,
        name: changes.name,
        exact: true,
      }),
    ).toBeVisible();
    await expectPublicDetails(anonymousPage, {
      Designation: changes.designation,
      Phone: changes.phone,
      "Blood group": changes.bloodGroup,
      Department: changes.publicDepartment,
      "Home address": changes.homeAddress,
      "Date of birth": "29 February 1992",
    });
    const publicHtml = await anonymousContext.request
      .get(`${origin}${path}`)
      .then((result) => result.text());
    for (const value of Object.values(privateValues)) {
      expect(publicHtml).not.toContain(value);
    }
  } finally {
    await anonymousContext.close();
  }
});

for (const role of ["ADMIN", "EMPLOYEE", "MANAGE_DRIVER"] as const) {
  test(`${role} cannot load or update the public profile editor`, async ({
    page,
    context,
  }) => {
    await signIn(context, role);
    const { user } = await profileFixture();
    const apiPath = `/api/admin/users/${user.id}/public-profile`;
    for (const response of [
      await context.request.get(apiPath),
      await context.request.patch(apiPath, {
        headers: { origin },
        data: { name: "Unauthorized name", phone: "Unauthorized phone" },
      }),
    ]) {
      expect(response.status()).toBe(403);
      expect((await response.json()).error.code).toBe("FORBIDDEN");
    }
    await page.goto(`/admin/users/${user.id}/profile`);
    await expect(page).toHaveURL(/\/forbidden$/);
    await expect(
      page.getByRole("button", { name: "Save public profile", exact: true }),
    ).toHaveCount(0);
    expect(
      await db.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).toMatchObject({
      name: user.name,
      ...publicDetails,
    });
  });
}

test("anonymous visitors can read the public page but cannot access the editor API or page", async ({
  page,
  context,
}) => {
  const { user } = await profileFixture();
  const apiPath = `/api/admin/users/${user.id}/public-profile`;
  for (const response of [
    await context.request.get(apiPath),
    await context.request.patch(apiPath, {
      headers: { origin },
      data: { name: "Unauthorized anonymous name" },
    }),
  ]) {
    expect(response.status()).toBe(401);
    expect((await response.json()).error.code).toBe("UNAUTHENTICATED");
  }
  await page.goto(`/admin/users/${user.id}/profile`);
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  await page.goto(`/profile/${user.id}`);
  await expect(
    page.getByRole("heading", { level: 1, name: user.name!, exact: true }),
  ).toBeVisible();
  expect(
    (await db.user.findUniqueOrThrow({ where: { id: user.id } })).name,
  ).toBe(user.name);
});
