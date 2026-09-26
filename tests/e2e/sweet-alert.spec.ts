import { randomUUID } from "node:crypto";
import {
  test,
  expect,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { testSessionCookie } from "./session-cookie";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
});
const createdUsers: string[] = [];
const origin = "http://localhost:3100";
const destinationFrom = '<strong data-alert-markup="example">Office</strong>';
const destinationTo = "Client site";
const deleteButtonName = `Delete drive cost from ${destinationFrom} to ${destinationTo}`;

async function signIn(context: BrowserContext) {
  const key = randomUUID();
  const user = await db.user.create({
    data: {
      name: "SweetAlert browser test",
      email: `sweet-alert-${key}@example.test`,
      role: "ADMIN",
      googleAccountId: key,
      accounts: {
        create: { provider: "google", type: "oidc", providerAccountId: key },
      },
    },
  });
  createdUsers.push(user.id);
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
}

test.beforeEach(async ({ context }) => signIn(context));
test.afterEach(async () => {
  // All resource writes below are mocked. Only these isolated-test identities
  // and their cascading sessions/accounts are persisted by this suite.
  await db.user.deleteMany({ where: { id: { in: createdUsers.splice(0) } } });
});
test.afterAll(async () => db.$disconnect());

async function driveFixture(page: Page, error?: string) {
  const writes: string[] = [];
  let items = [
    {
      id: "sweet-alert-drive",
      date: "2032-02-19T00:00:00.000Z",
      destinationFrom,
      destinationTo,
      kilometers: "10.00",
      isRoundTrip: false,
      rateType: "IN_TIME",
      paymentStatus: "UNPAID",
      ratePerKilometer: "5.00",
      totalCost: "50.00",
    },
  ];
  await page.route(
    /\/api\/admin\/drive-costs(?:\/[^/?]+)?(?:\?.*)?$/,
    async (route) => {
      const request = route.request();
      if (request.method() === "DELETE") {
        writes.push(request.url());
        if (error) {
          await route.fulfill({
            status: 409,
            json: {
              success: false,
              error: { code: "CONFLICT", message: error },
            },
          });
        } else {
          items = [];
          await route.fulfill({
            json: { success: true, data: { id: "sweet-alert-drive" } },
          });
        }
        return;
      }
      if (request.method() !== "GET")
        throw new Error(`Unexpected method: ${request.method()}`);
      await route.fulfill({
        json: {
          success: true,
          data: { items, total: items.length, page: 1, pageSize: 25 },
        },
      });
    },
  );
  await page.goto("/admin/drive-cost");
  await expect(
    page.getByRole("button", { name: deleteButtonName, exact: true }),
  ).toBeVisible();
  return writes;
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("destructive confirmation supports keyboard cancellation, literal text, and success feedback", async ({
  page,
}, testInfo) => {
  const writes = await driveFixture(page);
  const remove = page.getByRole("button", {
    name: deleteButtonName,
    exact: true,
  });
  const dialog = page.getByRole("dialog", {
    name: "Delete this drive cost?",
    exact: true,
  });

  await remove.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await expect(dialog).toContainText(destinationFrom);
  await expect(dialog.locator("[data-alert-markup]")).toHaveCount(0);
  expect(writes).toHaveLength(0);
  await capture(page, testInfo, "sweet-alert-desktop");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(remove).toBeEnabled();
  await expect(remove).toBeFocused();
  expect(writes).toHaveLength(0);

  await remove.click();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(remove).toBeEnabled();
  expect(writes).toHaveLength(0);

  await remove.click();
  await dialog
    .getByRole("button", { name: "Delete drive cost", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => writes.length).toBe(1);
  const success = "Drive cost deleted successfully.";
  await expect(page.locator(".notice.success")).toContainText(success);
  const toast = page.locator(".swal2-popup.app-alert-toast");
  await expect(toast).toContainText(success);
  await expect(toast).toHaveAttribute("role", "status");
  await toast.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(toast).toBeHidden();
  await expect(page.locator(".notice.success")).toContainText(success);
  await expect(remove).toHaveCount(0);
});

test("mobile confirmation fits the screen and failed actions keep an inline error after toast dismissal", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const message =
    'Cannot delete <strong data-alert-markup="error">this record</strong> while it is referenced.';
  const writes = await driveFixture(page, message);
  const remove = page.getByRole("button", {
    name: deleteButtonName,
    exact: true,
  });
  await remove.click();
  const dialog = page.getByRole("dialog", {
    name: "Delete this drive cost?",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await capture(page, testInfo, "sweet-alert-mobile");
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(box!.y + box!.height).toBeLessThanOrEqual(812);
  expect(writes).toHaveLength(0);

  await dialog
    .getByRole("button", { name: "Delete drive cost", exact: true })
    .click();
  await expect.poll(() => writes.length).toBe(1);
  await expect(page.locator(".notice.error")).toContainText(message);
  const toast = page.locator(".swal2-popup.app-alert-toast");
  await expect(toast).toContainText(message);
  await expect(toast.locator("[data-alert-markup]")).toHaveCount(0);
  await toast.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(toast).toBeHidden();
  await expect(page.locator(".notice.error")).toContainText(message);
  await expect(remove).toBeEnabled();
  expect(writes).toHaveLength(1);
});

test("leave review distinguishes cancelling a prompt from saving an optional empty note", async ({
  page,
}) => {
  const writes: { id: string; status: string; reviewNote: string }[] = [];
  const leaves = ["Optional note employee", "Written note employee"].map(
    (name, index) => ({
      id: `sweet-alert-leave-${index}`,
      employee: { user: { name } },
      startDate: "2032-02-19T00:00:00.000Z",
      endDate: "2032-02-20T00:00:00.000Z",
      reason: "Planned time away",
      status: "PENDING",
    }),
  );
  await page.route(
    /\/api\/admin\/leaves(?:\/[^/?]+)?(?:\?.*)?$/,
    async (route) => {
      const request = route.request();
      if (request.method() === "PATCH") {
        const id = new URL(request.url()).pathname.split("/").at(-1)!;
        const input = request.postDataJSON() as {
          status: string;
          reviewNote: string;
        };
        writes.push({ id, ...input });
        const leave = leaves.find((item) => item.id === id)!;
        leave.status = input.status;
        await route.fulfill({
          json: {
            success: true,
            data: { ...leave, reviewNote: input.reviewNote },
          },
        });
        return;
      }
      if (request.method() !== "GET")
        throw new Error(`Unexpected method: ${request.method()}`);
      await route.fulfill({
        json: {
          success: true,
          data: { items: leaves, total: leaves.length, page: 1, pageSize: 25 },
        },
      });
    },
  );
  await page.goto("/admin/leaves");
  const optionalRow = page
    .getByRole("row")
    .filter({ hasText: "Optional note employee" });
  const prompt = page.getByRole("dialog", {
    name: "Approve leave?",
    exact: true,
  });
  await optionalRow
    .getByRole("button", { name: "Approve", exact: true })
    .click();
  await expect(prompt.getByLabel("Review note (optional)")).toHaveValue("");
  await expect(prompt.getByLabel("Review note (optional)")).toHaveAttribute(
    "maxlength",
    "1000",
  );
  expect(writes).toHaveLength(0);
  await prompt.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(prompt).toBeHidden();
  expect(writes).toHaveLength(0);

  await optionalRow
    .getByRole("button", { name: "Approve", exact: true })
    .click();
  await prompt
    .getByRole("button", { name: "Approve leave", exact: true })
    .click();
  await expect
    .poll(() => writes)
    .toEqual([{ id: leaves[0].id, status: "APPROVED", reviewNote: "" }]);
  await expect(optionalRow).toContainText("approved");

  const writtenRow = page
    .getByRole("row")
    .filter({ hasText: "Written note employee" });
  await writtenRow
    .getByRole("button", { name: "Decline", exact: true })
    .click();
  const decline = page.getByRole("dialog", {
    name: "Decline leave?",
    exact: true,
  });
  const note = "Please choose another date.\nWe need coverage that day.";
  await decline.getByLabel("Review note (optional)").fill(note);
  await decline
    .getByRole("button", { name: "Decline leave", exact: true })
    .click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({
    id: leaves[1].id,
    status: "REJECTED",
    reviewNote: note,
  });
  await expect(writtenRow).toContainText("rejected");
});
