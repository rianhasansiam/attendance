import {
  parse,
  TYPE,
  type MessageFormatElement,
} from "@formatjs/icu-messageformat-parser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { createTranslator, type AbstractIntlMessages } from "next-intl";
import { resolveLocale, localeCookie, localeMaxAge } from "@/i18n/config";
import { loadMessages, withEnglishFallback } from "@/i18n/messages";
import { localizeError } from "@/i18n/errors";
import { POST } from "@/app/api/locale/route";
import { date, duration, time } from "@/components/ui";

const serverConfig = vi.hoisted(() => ({
  AUTH_URL: "https://attendance.test",
}));
vi.mock("@/lib/env", () => ({ getEnv: () => serverConfig }));

function flatten(
  messages: AbstractIntlMessages,
  prefix = "",
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(messages).flatMap(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof value === "string"
        ? [[path, value]]
        : Object.entries(flatten(value, path));
    }),
  );
}
function placeholders(value: string) {
  const names = new Set<string>();
  function walk(elements: MessageFormatElement[]) {
    for (const element of elements) {
      if (element.type !== TYPE.literal && element.type !== TYPE.pound)
        names.add(element.value);
      if (element.type === TYPE.select || element.type === TYPE.plural)
        Object.values(element.options).forEach((option) => walk(option.value));
      if (element.type === TYPE.tag) walk(element.children);
    }
  }
  walk(parse(value));
  return [...names].sort();
}

describe("translation dictionaries", () => {
  for (const file of readdirSync("messages/en")) {
    it(`${file} has complete Chinese keys and matching interpolation variables`, () => {
      const en = flatten(
        JSON.parse(readFileSync(`messages/en/${file}`, "utf8")),
      );
      const zh = flatten(
        JSON.parse(readFileSync(`messages/zh-CN/${file}`, "utf8")),
      );
      expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
      for (const key of Object.keys(en)) {
        expect(zh[key].trim(), key).not.toBe("");
        expect(placeholders(zh[key]), key).toEqual(placeholders(en[key]));
      }
    });
  }
  it("defaults invalid preferences to English and only accepts supported locales", () => {
    for (const value of [undefined, null, "", "zh", "fr", "../en", "ZH-CN", {}])
      expect(resolveLocale(value)).toBe("en");
    expect(resolveLocale("zh-CN")).toBe("zh-CN");
    expect(resolveLocale("en")).toBe("en");
  });
  it("explicitly merges missing Chinese messages with English, preserving ICU plurals", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const messages = withEnglishFallback(
      {
        example: {
          greeting: "Hello {name}",
          records: "{count, plural, one {# record} other {# records}}",
        },
      },
      { example: { greeting: "你好，{name}" } },
      true,
    );
    const t = createTranslator({
      locale: "en",
      messages: messages as { example: { greeting: string; records: string } },
    });
    expect(t("example.greeting", { name: "User" })).toBe("你好，User");
    expect(t("example.records", { count: 1 })).toBe("1 record");
    expect(t("example.records", { count: 2 })).toBe("2 records");
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("example.records"),
    );
    warning.mockRestore();
  });
  it("loads request-local messages without cross-user locale state", async () => {
    const [english, chinese, englishAgain] = await Promise.all([
      loadMessages("en"),
      loadMessages("zh-CN"),
      loadMessages("en"),
    ]);
    expect(english).toEqual(englishAgain);
    expect((english.common as AbstractIntlMessages).save).toBe("Save");
    expect((chinese.common as AbstractIntlMessages).save).toBe("保存");
  });
  it("maps safe API codes and never reveals unknown internal errors", () => {
    expect(
      localizeError(
        { code: "FORBIDDEN", message: "private stack / credential" },
        "zh-CN",
      ),
    ).toBe("您无权访问此资源。");
    expect(localizeError(new Error("postgres private credential"), "en")).toBe(
      "Unable to complete the request. Please try again.",
    );
  });
  it("preserves UTC date-only values, office timezone and signed durations", () => {
    const value = "2026-09-28T23:30:00Z";
    expect(date(value, "en")).toContain("28");
    expect(date(value, "zh-CN")).toContain("28");
    expect(time(value, "Asia/Dhaka", "zh-CN")).toBe(
      new Date(value).toLocaleTimeString("zh-CN", {
        timeZone: "Asia/Dhaka",
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
    expect(duration(-90, "en")).toBe("-1h 30m");
    expect(duration(-90, "zh-CN")).toBe("-1小时 30分钟");
  });
});

describe("locale preference endpoint", () => {
  beforeEach(() => {
    serverConfig.AUTH_URL = "https://attendance.test";
  });

  function request(locale: unknown, origin = "https://attendance.test") {
    return new Request("https://attendance.test/api/locale", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ locale }),
    });
  }
  it("persists validated language for a year throughout the app without touching sessions", async () => {
    const response = await POST(request("zh-CN"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ locale: "zh-CN" });
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain(`${localeCookie}=zh-CN`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${localeMaxAge}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).not.toContain("authjs");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects invalid locales, malformed payloads and cross-origin writes", async () => {
    expect((await POST(request("../../etc"))).status).toBe(400);
    expect((await POST(request("en", "https://elsewhere.test"))).status).toBe(
      403,
    );
    const response = await POST(
      new Request("https://attendance.test/api/locale", {
        method: "POST",
        headers: { Origin: "https://attendance.test" },
        body: "{",
      }),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it.each([
    "http://127.0.0.1:3000/api/locale",
    "https://127.0.0.1:3000/api/locale",
  ])("accepts the public origin behind a proxy at %s", async (upstream) => {
    const response = await POST(
      new Request(upstream, {
        method: "POST",
        headers: {
          Origin: "https://attendance.test",
          Host: "attendance.test",
          "X-Forwarded-Host": "attendance.test",
          "X-Forwarded-Proto": "https",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ locale: "zh-CN" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ locale: "zh-CN" });
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("does not trust a matching request URL or forwarded headers over the configured origin", async () => {
    const response = await POST(
      new Request("https://elsewhere.test/api/locale", {
        method: "POST",
        headers: {
          Origin: "https://elsewhere.test",
          Host: "elsewhere.test",
          "X-Forwarded-Host": "elsewhere.test",
          "X-Forwarded-Proto": "https",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ locale: "en" }),
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "INVALID_ORIGIN" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("keeps local HTTP development cookies usable", async () => {
    serverConfig.AUTH_URL = "http://localhost:3000";
    const response = await POST(
      new Request("http://127.0.0.1:3000/api/locale", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ locale: "zh-CN" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("rejects explicit cross-site requests even with the configured Origin", async () => {
    const input = request("en");
    input.headers.set("sec-fetch-site", "cross-site");
    const response = await POST(input);
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it.each([null, "null"])(
    "rejects an unverifiable Origin %j",
    async (origin) => {
      const input = request("en");
      if (origin === null) input.headers.delete("origin");
      else input.headers.set("origin", origin);
      const response = await POST(input);
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
    },
  );
});
