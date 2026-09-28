import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { useQueryView } from "@/store/use-query-view";
import english from "../messages/en/common.json";
import chinese from "../messages/zh-CN/common.json";

function renderView<T>(
  locale: "en" | "zh-CN",
  error: unknown,
  currentData?: T,
) {
  const refetch = vi.fn();
  let result!: ReturnType<typeof useQueryView<T, typeof refetch>>;
  function Probe() {
    result = useQueryView({
      currentData,
      error,
      isFetching: false,
      isLoading: false,
      refetch,
    });
    return null;
  }
  renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      {
        locale,
        timeZone: "Asia/Dhaka",
        messages: { common: locale === "en" ? english : chinese },
      } as Parameters<typeof NextIntlClientProvider>[0],
      createElement(Probe),
    ),
  );
  return { result, refetch };
}

describe("localized query feedback", () => {
  it("uses a safe Chinese fallback for unknown server diagnostics", () => {
    const privateMessage = "Internal SQL error: password=private-diagnostic";
    const { result } = renderView("zh-CN", {
      status: 500,
      code: "UNEXPECTED_INTERNAL",
      message: privateMessage,
    });
    expect(result.error).toBe(chinese.errors.REQUEST_FAILED);
    expect(result.error).not.toContain(privateMessage);
    expect(result.data).toBeUndefined();
    expect(result.loading).toBe(false);
  });

  it("translates stable access codes and hides previously loaded protected data", () => {
    const { result } = renderView(
      "zh-CN",
      {
        status: 403,
        code: "FORBIDDEN",
        message: "Private authorization diagnostics",
      },
      { private: "retained data" },
    );
    expect(result.data).toBeUndefined();
    expect(result.error).toBe(chinese.errors.FORBIDDEN);
    expect(result.error).not.toContain("之前加载");
  });

  it("translates the complete stale-data warning while preserving records and refetch", () => {
    const records = { items: [{ name: "Stored employee name 用户姓名" }] };
    const error = {
      status: 503,
      code: "UNEXPECTED_INTERNAL",
      message: "Private upstream diagnostics",
    };
    const zh = renderView("zh-CN", error, records);
    const en = renderView("en", error, records);
    expect(zh.result.error).toBe(
      `刷新失败，当前显示的是之前加载的数据。${chinese.errors.REQUEST_FAILED}`,
    );
    expect(en.result.error).toBe(
      `Refresh failed. Showing previously loaded data. ${english.errors.REQUEST_FAILED}`,
    );
    expect(zh.result.error).not.toContain("Private upstream");
    expect(zh.result.error).not.toContain("Refresh failed");
    expect(zh.result.data).toBe(records);
    expect(en.result.data).toBe(records);
    expect(zh.result.refresh).toBe(zh.refetch);
  });

  it("translates known transport failures and leaves successful responses untouched", () => {
    const error = {
      status: "FETCH_ERROR",
      code: "NETWORK_ERROR",
      message:
        "The request could not be confirmed. Refresh to check its status before trying again.",
    };
    expect(renderView("zh-CN", error).result.error).toBe(
      chinese.errors.NETWORK_ERROR,
    );
    const data = { status: "PENDING", amount: "100.00", date: "2026-09-28" };
    const { result } = renderView("zh-CN", undefined, data);
    expect(result.error).toBe("");
    expect(result.data).toBe(data);
    expect(result.isFetching).toBe(false);
  });
});
