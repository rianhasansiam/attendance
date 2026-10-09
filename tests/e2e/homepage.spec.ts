import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // Homepage checks never request private APIs or provision database records.
  await page.route("**/api/**", (route) => route.abort());
});

for (const width of [1920, 1440, 1024, 768, 390, 320]) {
  test(`homepage content, assets and anchors fit ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const runtimeErrors: string[] = [];
    const failedResources: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    page.on("requestfailed", (request) => failedResources.push(request.url()));
    page.on("response", (response) => {
      if (response.status() >= 400) failedResources.push(response.url());
    });

    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page).toHaveTitle(/^XHYD — Connecting Innovation/);
    await expect(page.locator("head title")).toHaveCount(1);
    await expect(page.locator('head meta[name="description"]')).toHaveCount(1);
    await expect(page.locator("#xhyd-site")).toHaveAttribute("lang", "en");
    const login = page
      .locator("header")
      .getByRole("link", { name: "Login", exact: true });
    await expect(login).toBeVisible();
    await expect(login).toHaveAttribute("href", "/login");
    await expect(
      page
        .locator("#global-presence")
        .getByRole("img", { name: /^XHYD global presence/ }),
    ).toBeVisible();

    const officialLogos = page.locator(
      'header img[alt="XHYD"]:visible, footer img[alt="XHYD"]:visible',
    );
    await expect(officialLogos).toHaveCount(2);
    const logoAppearance = await officialLogos.evaluateAll((images) =>
      images.map((image) => {
        const element = image as HTMLImageElement;
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        const source = new URL(
          element.currentSrc || element.src,
          location.href,
        );
        return {
          original:
            source.pathname === "/company_logo.jpeg" ||
            source.searchParams.get("url") === "/company_logo.jpeg",
          filter: style.filter,
          blend: style.mixBlendMode,
          aspect:
            (bounds.width -
              parseFloat(style.paddingLeft) -
              parseFloat(style.paddingRight) -
              parseFloat(style.borderLeftWidth) -
              parseFloat(style.borderRightWidth)) /
            (bounds.height -
              parseFloat(style.paddingTop) -
              parseFloat(style.paddingBottom) -
              parseFloat(style.borderTopWidth) -
              parseFloat(style.borderBottomWidth)),
          expectedAspect:
            Number(element.getAttribute("width")) /
            Number(element.getAttribute("height")),
        };
      }),
    );
    for (const logo of logoAppearance) {
      expect(logo.original).toBe(true);
      expect(logo.filter).toBe("none");
      expect(logo.blend).toBe("normal");
      expect(Math.abs(logo.aspect / logo.expectedAspect - 1)).toBeLessThan(
        0.02,
      );
    }

    const primaryActionColor = await page
      .locator("#home")
      .getByRole("link", { name: "Explore Our Businesses", exact: true })
      .evaluate((link) => getComputedStyle(link).backgroundColor);
    const channels = primaryActionColor.match(/[\d.]+/g)?.map(Number);
    expect(
      channels,
      "The primary business CTA has a solid red surface",
    ).toBeDefined();
    expect(channels![0]).toBeGreaterThan(channels![1] * 1.5);
    expect(channels![0]).toBeGreaterThan(channels![2] * 1.5);

    for (const id of [
      "about",
      "businesses",
      "global-presence",
      "why-xhyd",
      "ecosystem",
      "partnerships",
      "contact",
    ]) {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      await expect(page.locator(`#${id} h2`).first()).toBeVisible();
    }

    await expect(page.locator("details")).toHaveCount(6);
    const invalidAnchors = await page
      .locator('a[href^="#"]')
      .evaluateAll((links) =>
        links
          .filter(
            (link) =>
              !document.getElementById(
                link.getAttribute("href")?.slice(1) || "",
              ),
          )
          .map((link) => link.getAttribute("href")),
      );
    expect(invalidAnchors).toEqual([]);

    await expect
      .poll(async () => {
        const images = await page
          .locator("img:visible")
          .evaluateAll((elements) =>
            elements.every(
              (element) =>
                (element as HTMLImageElement).complete &&
                (element as HTMLImageElement).naturalWidth > 0,
            ),
          );
        return images;
      })
      .toBe(true);

    const pageWidth = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(pageWidth.document).toBeLessThanOrEqual(width + 1);
    expect(pageWidth.body).toBeLessThanOrEqual(width + 1);
    expect(runtimeErrors).toEqual([]);
    expect(failedResources).toEqual([]);
  });
}

test("desktop navigation reaches sections below the sticky header", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });

  for (const name of [
    "Home",
    "About XHYD",
    "Our Businesses",
    "Global Presence",
    "Why XHYD",
    "Contact",
  ]) {
    const link = navigation.getByRole("link", { name, exact: true });
    const href = (await link.getAttribute("href"))!;
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    if (href === "#home") continue;
    const position = await page.evaluate((selector) => {
      const target = document.querySelector(selector)!.getBoundingClientRect();
      const header = document.querySelector("header")!.getBoundingClientRect();
      return { targetTop: target.top, headerBottom: header.bottom };
    }, href);
    expect(position.targetTop).toBeGreaterThanOrEqual(
      position.headerBottom - 2,
    );
  }
});

test("mobile drawer supports keyboard focus, Escape, backdrop and anchor close", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Open navigation" });
  const dialog = page.getByRole("dialog", { name: "XHYD navigation" });

  await trigger.click();
  await expect(dialog).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const dashboardLogin = dialog.getByRole("link", {
    name: "Dashboard login",
    exact: true,
  });
  await expect(dashboardLogin).toBeVisible();
  await expect(dashboardLogin).toHaveAttribute("href", "/login");
  await expect(
    dialog.getByRole("button", { name: "Close navigation" }),
  ).toBeFocused();
  const tabbable = dialog.locator("a, button");
  await tabbable.last().focus();
  await page.keyboard.press("Tab");
  // Native dialog traversal can visit the browser chrome between cycles.
  // No page element outside the modal may receive focus.
  if (await page.evaluate(() => document.activeElement === document.body)) {
    await page.keyboard.press("Tab");
  }
  await expect(tabbable.first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  if (await page.evaluate(() => document.activeElement === document.body)) {
    await page.keyboard.press("Shift+Tab");
  }
  await expect(tabbable.last()).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await page.mouse.click(15, 400);
  await expect(dialog).not.toBeVisible();

  await trigger.click();
  await dialog.getByRole("link", { name: "Our Businesses" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page).toHaveURL(/#businesses$/);
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("");
});

test("business capabilities open and close from the keyboard", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const summaries = page.locator("details summary");
  await expect(summaries).toHaveCount(6);
  for (let index = 0; index < 6; index++) {
    const summary = summaries.nth(index);
    await expect(summary).toBeVisible();
    await summary.focus();
    await expect(summary).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(summary.locator("..")).toHaveAttribute("open", "");
    await page.keyboard.press("Space");
    await expect(summary.locator("..")).not.toHaveAttribute("open");
  }
});

test("contact prepares an honest draft with copy and manual-copy fallback", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const trigger = page.getByRole("button", {
    name: "Contact XHYD",
    exact: true,
  });
  const dialog = page.getByRole("dialog", {
    name: "Let’s explore what’s next.",
  });
  await trigger.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    "This prepares a draft; it does not send it.",
  );
  await expect(
    dialog.getByRole("button", { name: "Close partnership inquiry" }),
  ).toBeFocused();
  await dialog
    .getByRole("combobox", { name: "Business area", exact: true })
    .selectOption({ label: "Product Manufacturing" });
  await dialog
    .getByRole("combobox", { name: "Market", exact: true })
    .selectOption({ label: "Bangladesh" });
  await dialog
    .getByLabel("Your introduction")
    .fill("An introduction from our business.");
  await dialog
    .getByRole("button", { name: "Copy inquiry", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Inquiry copied" }),
  ).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("Business area: Product Manufacturing");
  expect(copied).toContain("Market: Bangladesh");
  expect(copied).toContain("An introduction from our business.");

  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async () => {
        throw new Error("Clipboard permission denied in browser test");
      },
    });
  });
  await dialog
    .getByLabel("Your introduction")
    .fill("A draft for manual copying.");
  await dialog
    .getByRole("button", { name: "Copy inquiry", exact: true })
    .click();
  const fallback = dialog.getByLabel("Select and copy your complete inquiry");
  await expect(fallback).toBeFocused();
  await expect(fallback).toHaveValue(/A draft for manual copying\./);
  expect(
    await fallback.evaluate(
      (element: HTMLTextAreaElement) =>
        element.selectionEnd - element.selectionStart === element.value.length,
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.mouse.click(10, 10);
  await expect(dialog).not.toBeVisible();
});

test("reduced motion leaves all content visible without animation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const motion = await page.evaluate(() => ({
    scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
    animations: Array.from(document.querySelectorAll("#xhyd-site *"))
      .map((element) => getComputedStyle(element).animationName)
      .filter((name) => name !== "none"),
    hiddenReveals: Array.from(
      document.querySelectorAll("[data-reveal]"),
    ).filter((element) => getComputedStyle(element).opacity === "0").length,
  }));
  expect(motion.scrollBehavior).toBe("auto");
  expect(motion.animations).toEqual([]);
  expect(motion.hiddenReveals).toBe(0);
});

test("server HTML contains corporate sections and SEO before hydration", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    baseURL: process.env.XHYD_PREVIEW_URL || "http://localhost:3000",
  });
  const page = await context.newPage();
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(/^XHYD — Connecting Innovation/);
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("h1")).toContainText("Connecting");
  await expect(page.locator("#businesses details")).toHaveCount(6);
  for (const id of [
    "about",
    "global-presence",
    "why-xhyd",
    "ecosystem",
    "partnerships",
    "contact",
  ]) {
    await expect(page.locator(`#${id} h2`).first()).toContainText(/\S/);
  }
  if (!(await page.locator("#xhyd-site").isVisible())) {
    testInfo.annotations.push({
      type: "existing-layout-limit",
      description:
        "The existing locale RootLayout streams its Suspense subtree hidden until JavaScript reveals it. Corporate content and metadata are server-rendered, but no-JavaScript visual rendering requires a separate root-layout change.",
    });
  }
  await context.close();
});
