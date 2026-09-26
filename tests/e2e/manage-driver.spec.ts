import { testSessionCookie } from "./session-cookie";
import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext } from "@playwright/test";
import { PrismaClient, type Role } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
});
const origin = "http://localhost:3100";
const tripDate = "2032-02-19";
const userIds: string[] = [];

async function signIn(context: BrowserContext, role: Role) {
  const suffix = randomUUID();
  const office = await db.office.create({
    data: {
      name: `Driver manager office ${suffix}`,
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
  const user = await db.user.create({
    data: {
      name: "Driver Manager",
      email: `manage-driver-${suffix}@example.test`,
      role,
      googleAccountId: suffix,
      employee: {
        create: { employeeCode: suffix, officeId: office.id },
      },
      accounts: {
        create: { type: "oidc", provider: "google", providerAccountId: suffix },
      },
    },
  });
  userIds.push(user.id);
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
      value: await testSessionCookie(db, token),
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return user;
}

test.afterEach(async () => {
  await db.driveCost.deleteMany({ where: { createdById: { in: userIds } } });
  await db.session.deleteMany({ where: { userId: { in: userIds } } });
  // Immutable audit history retains its referenced users in the disposable DB.
  userIds.length = 0;
});

test.afterAll(async () => {
  await db.$disconnect();
});

test("administrators can assign and remove driver management from an employee", async ({
  page,
  context,
}) => {
  const employee = await signIn(context, "EMPLOYEE");
  await signIn(context, "ADMIN");
  await page.goto("/admin/employees");
  await page
    .getByRole("textbox", { name: "Search employees" })
    .fill(employee.email);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Edit employee", exact: true })
    .click();
  const edit = page.getByRole("dialog", { name: "Edit employee" });
  await expect(edit.getByLabel("Role", { exact: true })).toHaveValue(
    "EMPLOYEE",
  );
  await edit.getByLabel("Role", { exact: true }).selectOption("MANAGE_DRIVER");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(edit).toBeHidden();
  expect(
    (await db.user.findUniqueOrThrow({ where: { id: employee.id } })).role,
  ).toBe("MANAGE_DRIVER");
  expect(await db.session.count({ where: { userId: employee.id } })).toBe(0);

  await page
    .getByRole("button", { name: "Edit employee", exact: true })
    .click();
  await expect(edit.getByLabel("Role", { exact: true })).toHaveValue(
    "MANAGE_DRIVER",
  );
  await edit.getByLabel("Role", { exact: true }).selectOption("EMPLOYEE");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(edit).toBeHidden();
  expect(
    (await db.user.findUniqueOrThrow({ where: { id: employee.id } })).role,
  ).toBe("EMPLOYEE");
});

test("driver managers retain the employee workspace without administrator access", async ({
  page,
  context,
}) => {
  await signIn(context, "MANAGE_DRIVER");
  for (const entry of ["/", "/login"]) {
    await page.goto(entry);
    await expect(page).toHaveURL(/\/employee\/dashboard$/);
  }

  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  for (const [name, path] of [
    ["My day", "dashboard"],
    ["Attendance history", "history"],
    ["Leave requests", "leaves"],
    ["My devices", "devices"],
    ["My profile", "profile"],
    ["Drive Cost", "drive-cost"],
  ]) {
    await expect(
      navigation.getByRole("link", { name, exact: true }),
    ).toHaveAttribute("href", `/employee/${path}`);
  }
  await expect(navigation.locator('a[href^="/admin/"]')).toHaveCount(0);
  await navigation
    .getByRole("link", { name: "My profile", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "My profile" })).toBeVisible();
  expect((await context.request.get("/api/employee/profile")).status()).toBe(
    200,
  );

  for (const path of [
    "/api/admin/dashboard",
    "/api/admin/employees",
    "/api/admin/users",
    "/api/admin/settings",
    "/api/admin/attendance",
    "/api/admin/lookups/offices",
  ]) {
    const response = await context.request.get(path);
    expect(response.status(), path).toBe(403);
  }
  const write = await context.request.post("/api/admin/departments", {
    headers: { origin },
    data: { name: `Forbidden department ${randomUUID()}` },
  });
  expect(write.status()).toBe(403);
  for (const path of ["/admin/dashboard", "/admin/drive-cost"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/forbidden$/);
  }
});

test("driver managers can create, calculate, report, edit and delete drive costs", async ({
  page,
  context,
}) => {
  const user = await signIn(context, "MANAGE_DRIVER");
  const destinationFrom = `Manager trip ${randomUUID()}`;
  await page.goto("/employee/dashboard");
  await page.getByRole("link", { name: "Drive Cost", exact: true }).click();
  await expect(page).toHaveURL(/\/employee\/drive-cost$/);
  await page
    .getByRole("button", { name: "Add drive cost", exact: true })
    .click();
  const create = page.getByRole("dialog", { name: "Add drive cost" });
  await create.getByLabel("Date *", { exact: true }).fill(tripDate);
  await create
    .getByLabel("Destination from *", { exact: true })
    .fill(destinationFrom);
  await create
    .getByLabel("Destination to *", { exact: true })
    .fill("Client office");
  await create.getByLabel("Kilometers (one way) *", { exact: true }).fill("10");
  await create.getByRole("button", { name: "Save drive cost" }).click();
  await expect(create).toBeHidden();

  const record = await db.driveCost.findFirstOrThrow({
    where: { createdById: user.id, destinationFrom },
  });
  expect(record.totalCost.toFixed(2)).toBe("50.00");
  expect(
    (await context.request.get(`/api/admin/drive-costs/${record.id}`)).status(),
  ).toBe(200);
  await page
    .getByRole("searchbox", { name: "Search drive costs" })
    .fill(destinationFrom);
  const list = page.locator("section.card").filter({
    has: page.getByRole("form", { name: "Filter drive costs by date" }),
  });
  await expect(list.locator("tbody tr")).toHaveCount(1);
  await expect(
    list.getByRole("cell", { name: "৳50.00", exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Cost calculator", exact: true })
    .click();
  const calculator = page.locator("section.calc-card");
  await calculator.getByLabel("Date", { exact: true }).fill(tripDate);
  await calculator
    .getByRole("button", { name: "Calculate", exact: true })
    .click();
  await expect(calculator.locator(".calc-total")).toContainText("৳50.00");
  await expect(calculator.locator(".calc-total")).toContainText(
    "1 trip · 10 km",
  );
  const report = await context.request.get(
    `/api/admin/drive-costs/report?from=${tripDate}&q=${encodeURIComponent(destinationFrom)}`,
  );
  expect(report.status()).toBe(200);
  expect(report.headers()["content-type"]).toBe("application/pdf");
  expect((await report.body()).subarray(0, 5).toString()).toBe("%PDF-");

  await list
    .getByRole("button", {
      name: `Edit drive cost from ${destinationFrom} to Client office`,
      exact: true,
    })
    .click();
  const edit = page.getByRole("dialog", { name: "Edit drive cost" });
  await edit.getByLabel("Kilometers (one way) *", { exact: true }).fill("12");
  await edit.getByRole("button", { name: "Save drive cost" }).click();
  await expect(edit).toBeHidden();
  await expect(
    list.getByRole("cell", { name: "৳60.00", exact: true }),
  ).toBeVisible();
  expect(
    (
      await db.driveCost.findUniqueOrThrow({ where: { id: record.id } })
    ).totalCost.toFixed(2),
  ).toBe("60.00");

  page.once("dialog", (dialog) => dialog.accept());
  await list
    .getByRole("button", {
      name: `Delete drive cost from ${destinationFrom} to Client office`,
      exact: true,
    })
    .click();
  await expect(
    list.getByText("Nothing here yet", { exact: true }),
  ).toBeVisible();
  expect(
    await db.driveCost.findUnique({ where: { id: record.id } }),
  ).toBeNull();
});

test("ordinary employees cannot discover or use drive cost management", async ({
  page,
  context,
}) => {
  const user = await signIn(context, "EMPLOYEE");
  const record = await db.driveCost.create({
    data: {
      date: new Date(`${tripDate}T00:00:00Z`),
      destinationFrom: "Protected trip",
      destinationTo: "Client office",
      kilometers: "10.00",
      rateType: "IN_TIME",
      ratePerKilometer: "5.00",
      totalCost: "50.00",
      createdById: user.id,
    },
  });
  await page.goto("/employee/dashboard");
  await expect(
    page.getByRole("link", { name: "Drive Cost", exact: true }),
  ).toHaveCount(0);
  await page.goto("/employee/drive-cost");
  await expect(page).toHaveURL(/\/forbidden$/);

  for (const path of [
    "/api/admin/drive-costs",
    `/api/admin/drive-costs/${record.id}`,
    `/api/admin/drive-costs/calculate?from=${tripDate}`,
    `/api/admin/drive-costs/report?from=${tripDate}`,
  ]) {
    expect((await context.request.get(path)).status(), path).toBe(403);
  }
  const payload = {
    date: tripDate,
    destinationFrom: "Unauthorized edit",
    destinationTo: "Client office",
    kilometers: 20,
    rateType: "IN_TIME",
  };
  for (const [method, path] of [
    ["POST", "/api/admin/drive-costs"],
    ["PATCH", `/api/admin/drive-costs/${record.id}`],
    ["DELETE", `/api/admin/drive-costs/${record.id}`],
  ]) {
    const response = await context.request.fetch(path, {
      method,
      headers: { origin },
      ...(method === "DELETE" ? {} : { data: payload }),
    });
    expect(response.status(), `${method} ${path}`).toBe(403);
  }
  const unchanged = await db.driveCost.findUniqueOrThrow({
    where: { id: record.id },
  });
  expect(unchanged.destinationFrom).toBe("Protected trip");
  expect(unchanged.totalCost.toFixed(2)).toBe("50.00");
  expect(await db.driveCost.count({ where: { createdById: user.id } })).toBe(1);
});
