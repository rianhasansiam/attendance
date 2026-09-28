import { randomUUID } from "node:crypto";
import { hash } from "argon2";
import { PrismaClient, type Role } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { testSessionCookie } from "./session-cookie";
import { localeCookie } from "../../src/i18n/config";

const origin = "http://localhost:3100";
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
});

test.afterAll(async () => db.$disconnect());
const renderingErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  renderingErrors.set(page, errors);
  const capture = (message: string) => {
    if (
      /hydration|hydrating|runtime data|blocking-prerender|infer the.*locale|MISSING_MESSAGE/i.test(
        message,
      )
    )
      errors.push(message);
  };
  page.on("pageerror", (error) => capture(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") capture(message.text());
  });
});
test.afterEach(async ({ page }) => {
  expect(
    renderingErrors.get(page),
    "Locale rendering must not cause hydration or runtime boundary errors",
  ).toEqual([]);
});

async function setLocale(context: BrowserContext, locale: string) {
  await context.addCookies([
    { name: localeCookie, value: locale, url: origin, sameSite: "Lax" },
  ]);
}

async function signIn(context: BrowserContext, role: Role) {
  const marker = randomUUID();
  const office = await db.office.create({
    data: {
      name: `Localization ${marker}`,
      address: "User-entered address 用户地址",
      latitude: 23.8,
      longitude: 90.4,
      timezone: "Asia/Dhaka",
    },
  });
  const user = await db.user.create({
    data: {
      name: "Localization User 用户姓名",
      email: `localization-${marker}@example.test`,
      role,
      googleAccountId: marker,
      employee: { create: { employeeCode: marker, officeId: office.id } },
    },
  });
  const sessionToken = randomUUID();
  await db.session.create({
    data: {
      userId: user.id,
      sessionToken,
      expires: new Date(Date.now() + 3_600_000),
    },
  });
  await context.addCookies([
    {
      name: "authjs.session-token",
      value: await testSessionCookie(db, sessionToken),
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return { user, office };
}

async function switchLanguage(page: Page, locale: "en" | "zh-CN") {
  const control = page.getByRole("combobox", { name: /^(Language|语言)$/ });
  await control.selectOption(locale);
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await expect(control).toHaveValue(locale);
  await expect(control).toBeEnabled();
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`${viewport.name}: login defaults, switching, persistence and responsive layout`, async ({
    page,
    context,
    browser,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await setLocale(context, "invalid-locale");
    await page.goto("/login?returnTo=%2Femployee%2Fhistory");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page).toHaveTitle("XHYD Attendance System");
    const email = page.locator('input[name="email"]');
    await email.fill("unsaved@example.test");
    const originalUrl = page.url();
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-login-en.png`),
      fullPage: true,
      animations: "disabled",
    });
    const selector = page.getByRole("combobox", {
      name: "Language",
      exact: true,
    });
    await selector.focus();
    await expect(selector).toBeFocused();
    await selector.selectOption("zh-CN");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(page).toHaveTitle("XHYD 考勤系统");
    await expect(email).toHaveValue("unsaved@example.test");
    expect(page.url()).toBe(originalUrl);
    await expect(
      page.getByRole("button", { name: "登录", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-login-zh-CN.png`),
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const preference = (await context.cookies()).find(
      (cookie) => cookie.name === localeCookie,
    )!;
    expect(preference.value).toBe("zh-CN");
    expect(preference.path).toBe("/");
    expect(preference.expires).toBeGreaterThan(
      Date.now() / 1000 + 300 * 24 * 60 * 60,
    );
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    const reopened = await browser.newContext({
      storageState: await context.storageState(),
    });
    try {
      const reopenedPage = await reopened.newPage();
      const response = await reopenedPage.goto(`${origin}/login`);
      const html = await response!.text();
      expect(html).toMatch(/<html[^>]*lang="zh-CN"/);
      expect(html).toContain("<title>XHYD 考勤系统</title>");
      await expect(reopenedPage).toHaveTitle("XHYD 考勤系统");
      await expect(
        reopenedPage.getByRole("combobox", { name: "语言", exact: true }),
      ).toHaveValue("zh-CN");
      await switchLanguage(reopenedPage, "en");
      await expect(reopenedPage).toHaveTitle("XHYD Attendance System");
      await expect(
        reopenedPage.getByRole("button", { name: "Sign in", exact: true }),
      ).toBeVisible();
    } finally {
      await reopened.close();
    }
  });
}

test("an unsuccessful language update preserves the current interface and unsaved login input", async ({
  page,
}) => {
  await page.goto("/login?error=AccessDenied");
  await page.locator('input[name="email"]').fill("still-here@example.test");
  await page.route("**/api/locale", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "unavailable" }),
    }),
  );
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-CN");
  await expect(
    page.locator(".language-switcher").getByRole("alert"),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(
    page.getByRole("combobox", { name: "Language", exact: true }),
  ).toHaveValue("en");
  await expect(page.locator('input[name="email"]')).toHaveValue(
    "still-here@example.test",
  );
  await expect(page).toHaveURL(/\/login\?error=AccessDenied$/);
});

test("switching an authenticated report preserves route, filters, pagination, unsaved inputs and session", async ({
  page,
  context,
}, testInfo) => {
  const { user, office } = await signIn(context, "SUPER_ADMIN");
  const path =
    "/admin/reports?from=2032-02-01&to=2032-02-20&status=PRESENT&page=2";
  await page.goto(path);
  const form = page
    .locator("form")
    .filter({ has: page.locator('input[name="from"]') });
  await form.locator('input[name="from"]').fill("2032-02-03");
  await form.locator('select[name="status"]').selectOption("LATE");
  const originalUrl = page.url();
  await expect(page.locator(".loading")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("desktop-reports-en.png"),
    fullPage: true,
    animations: "disabled",
  });
  await switchLanguage(page, "zh-CN");
  await expect(
    page.getByRole("heading", { name: "考勤报表", exact: true }),
  ).toBeVisible();
  await expect(form.locator('input[name="from"]')).toHaveValue("2032-02-03");
  await expect(form.locator('select[name="status"]')).toHaveValue("LATE");
  expect(page.url()).toBe(originalUrl);
  await page.screenshot({
    path: testInfo.outputPath("desktop-reports-zh-CN.png"),
    fullPage: true,
    animations: "disabled",
  });
  const session = await context.request
    .get("/api/auth/session")
    .then((response) => response.json());
  expect(session.user.id).toBe(user.id);
  expect(session.user.role).toBe("SUPER_ADMIN");
  expect(
    (await db.office.findUniqueOrThrow({ where: { id: office.id } })).timezone,
  ).toBe("Asia/Dhaka");
  const navigation = page.getByRole("navigation", { name: "主导航" });
  await navigation.getByRole("link", { name: "员工", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/employees$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "员工", exact: true }),
  ).toBeVisible();
});

for (const locale of ["en", "zh-CN"] as const) {
  for (const role of [
    "EMPLOYEE",
    "MANAGE_DRIVER",
    "ADMIN",
    "SUPER_ADMIN",
  ] as const) {
    test(`${role} retains navigation and authorization in ${locale}`, async ({
      page,
      context,
    }, testInfo) => {
      const mobile = role === "EMPLOYEE" || role === "MANAGE_DRIVER";
      if (mobile) await page.setViewportSize({ width: 390, height: 844 });
      const { user } = await signIn(context, role);
      await setLocale(context, locale);
      const admin = role === "ADMIN" || role === "SUPER_ADMIN";
      const response = await page.goto(
        admin ? "/admin/dashboard" : "/employee/dashboard",
      );
      expect(await response!.text()).toMatch(
        new RegExp(`<html[^>]*lang="${locale}"`),
      );
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(
        page.getByRole("combobox", {
          name: locale === "en" ? "Language" : "语言",
          exact: true,
        }),
      ).toHaveValue(locale);
      if (mobile)
        await page
          .getByRole("button", {
            name: locale === "en" ? "Open menu" : "打开菜单",
            exact: true,
          })
          .click();
      const navigation = page.getByRole("navigation", {
        name: locale === "en" ? "Main navigation" : "主导航",
      });
      await expect(navigation).toBeVisible();
      if (admin) {
        await expect(
          navigation.locator('a[href="/admin/employees"]'),
        ).toBeVisible();
        await expect(
          navigation.locator('a[href="/admin/settings"]'),
        ).toHaveCount(role === "SUPER_ADMIN" ? 1 : 0);
      } else {
        await expect(navigation.locator('a[href^="/admin/"]')).toHaveCount(0);
        await expect(
          navigation.locator('a[href="/employee/drive-cost"]'),
        ).toHaveCount(role === "MANAGE_DRIVER" ? 1 : 0);
      }
      await page.screenshot({
        path: testInfo.outputPath(`${role.toLowerCase()}-${locale}.png`),
        fullPage: true,
        animations: "disabled",
      });
      if (mobile) {
        await page
          .getByRole("button", {
            name: locale === "en" ? "Close navigation" : "关闭导航",
            exact: true,
          })
          .click({ position: { x: 380, y: 20 } });
        await page.screenshot({
          path: testInfo.outputPath(
            `${role.toLowerCase()}-${locale}-content.png`,
          ),
          fullPage: true,
          animations: "disabled",
        });
      }
      expect((await context.request.get("/api/admin/dashboard")).status()).toBe(
        admin ? 200 : 403,
      );
      expect((await context.request.get("/api/admin/settings")).status()).toBe(
        role === "SUPER_ADMIN" ? 200 : 403,
      );
      expect(
        (
          await context.request
            .get("/api/auth/session")
            .then((result) => result.json())
        ).user.id,
      ).toBe(user.id);
      if (role !== "SUPER_ADMIN") {
        await page.goto(admin ? "/admin/settings" : "/admin/dashboard");
        await expect(page).toHaveURL(/\/forbidden$/);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        await expect(page.getByRole("heading")).toContainText(
          locale === "en" ? "Access restricted" : "访问受限",
        );
      }
    });
  }
}

for (const locale of ["en", "zh-CN"] as const) {
  test(`password sign-in and sign-out keep the selected language in ${locale}`, async ({
    page,
    context,
  }) => {
    const marker = randomUUID();
    const password = "localization browser passphrase";
    const user = await db.user.create({
      data: {
        name: "Localized Sign In",
        email: `locale-login-${marker}@example.test`,
        role: "ADMIN",
        passwordHash: await hash(password),
      },
    });
    await setLocale(context, locale);
    await page.goto("/login");
    await page.locator('input[name="email"]').fill(user.email);
    await page.locator('input[name="password"]').fill(password);
    await page
      .getByRole("button", {
        name: locale === "en" ? "Sign in" : "登录",
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(/\/admin\/dashboard$/);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    const session = await context.request
      .get("/api/auth/session")
      .then((response) => response.json());
    expect(session.user.id).toBe(user.id);
    await page
      .getByRole("button", {
        name: locale === "en" ? "Sign out" : "退出登录",
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
  });
}

for (const locale of ["en", "zh-CN"] as const) {
  test(`missing pages render localized fallback without runtime errors in ${locale}`, async ({
    page,
    context,
  }) => {
    await setLocale(context, locale);
    await page.goto(`/unknown-localized-page-${randomUUID()}`);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.getByRole("heading")).toHaveText(
      locale === "en" ? "A little off the path." : "找不到此页面。",
    );
  });
}
