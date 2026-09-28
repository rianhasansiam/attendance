// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider } from "react-redux";
import { NextIntlClientProvider } from "next-intl";
import { loadMessages } from "@/i18n/messages";
import type { Locale } from "@/i18n/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriveCostBalanceSection } from "@/components/drive-cost-balance-section";
import {
  clearWorkspaceData,
  makeStore,
  type AppStore,
} from "@/store/make-store";

vi.mock("@/lib/client/alerts", () => ({
  enqueueNotification: vi.fn(() => () => {}),
  resetAlerts: vi.fn(),
}));

const NativeRequest = globalThis.Request;
let root: Root;
let container: HTMLDivElement;
let store: AppStore;
const refresh = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "Request",
    class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(
          typeof input === "string"
            ? new URL(input, "https://attendance.test")
            : input,
          init,
        );
      }
    },
  );
  refresh.mockClear();
  store = makeStore();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  clearWorkspaceData(store);
  container.remove();
  vi.unstubAllGlobals();
});

async function render(canAddBalance: boolean, locale: Locale = "en") {
  const messages = await loadMessages(locale);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale,
        timeZone: "Asia/Dhaka",
        messages,
        children: h(Provider, {
          store,
          children: h(DriveCostBalanceSection, {
            canAddBalance,
            data: {
              balance: "-90071992547409.93",
              totalAdded: "50.00",
              totalPaid: "90071992547459.93",
            },
            error: "",
            loading: false,
            isFetching: false,
            refresh,
          }),
        }),
      }),
    );
  });
}

function input(name: string) {
  return container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
}

async function fill(name: string, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input(name), value);
    input(name).dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("drive cost balance controls", () => {
  it("shows exact negative balances to viewers while hiding balance additions", async () => {
    await render(false);
    expect(container.textContent).toContain("-৳90,071,992,547,409.93");
    expect(container.textContent).toContain("৳90,071,992,547,459.93");
    expect(container.querySelector(".balance-negative")).not.toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("retains the exact addition for a manual idempotent retry and blocks double submission", async () => {
    const bodies: Record<string, unknown>[] = [];
    let finish!: (response: Response) => void;
    const fetch = vi.fn(async (request: Request) => {
      bodies.push(await request.json());
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    vi.stubGlobal("fetch", fetch);
    await render(true);
    await fill("amount", "12.50");
    await fill("note", "  Fuel budget  ");
    await submit();
    await submit();
    await act(async () => {
      await vi.waitFor(() => expect(bodies).toHaveLength(1));
    });
    expect(bodies[0]).toEqual({
      requestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      amount: "12.50",
      note: "Fuel budget",
    });
    expect(input("amount").disabled).toBe(true);
    await act(async () => {
      finish(
        Response.json(
          { success: false, error: { message: "Response interrupted" } },
          { status: 500 },
        ),
      );
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Retry balance addition"),
      );
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(input("amount").disabled).toBe(true);
    expect(input("note").disabled).toBe(true);
    expect(input("amount").value).toBe("12.50");

    await submit();
    await act(async () => {
      await vi.waitFor(() => expect(bodies).toHaveLength(2));
    });
    expect(bodies[1]).toEqual(bodies[0]);
    await act(async () => {
      finish(
        Response.json({
          success: true,
          data: { id: "addition", amount: "12.50", note: "Fuel budget" },
        }),
      );
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain(
          "Drive cost balance added successfully.",
        ),
      );
    });
    expect(input("amount").disabled).toBe(false);
    expect(input("amount").value).toBe("");
    expect(input("note").value).toBe("");

    await fill("amount", "1.00");
    await submit();
    await act(async () => {
      await vi.waitFor(() => expect(bodies).toHaveLength(3));
    });
    expect(bodies[2].requestId).not.toBe(bodies[0].requestId);
    await act(async () => {
      finish(Response.json({ success: true, data: { id: "next-addition" } }));
    });
  });

  it.each(["0", "-1", "1.001", "10000000000"])(
    "rejects the invalid addition %s before making a request",
    async (amount) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await render(true);
      await fill("amount", amount);
      await submit();
      expect(fetch).not.toHaveBeenCalled();
      expect(container.textContent).toContain(
        "Enter an amount greater than zero",
      );
    },
  );
});

it("switches the balance form without losing its amount or user-written note", async () => {
  await render(true);
  await fill("amount", "12.50");
  await fill("note", "September budget 九月预算");
  await render(true, "zh-CN");
  expect(container.textContent).toContain("行车费用余额");
  expect(container.textContent).toContain("-৳90,071,992,547,409.93");
  expect(input("amount").value).toBe("12.50");
  expect(input("note").value).toBe("September budget 九月预算");
  expect(container.textContent).toContain("金额（BDT）");
  await render(true);
  expect(input("amount").value).toBe("12.50");
  expect(container.textContent).toContain("Drive cost balance");
});
