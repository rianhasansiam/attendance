// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider } from "react-redux";
import { NextIntlClientProvider } from "next-intl";
import { loadMessages } from "@/i18n/messages";
import type { Locale } from "@/i18n/config";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DailyExpensesWorkspace } from "@/components/daily-expenses-workspace";
import {
  canWriteDailyExpenses,
  canEditDailyExpenseTransactions,
  canDeleteDailyExpenseTransactions,
  canDownloadDailyExpenseReport,
} from "@/modules/daily-expenses/permissions";
import {
  makeStore,
  clearWorkspaceData,
  type AppStore,
} from "@/store/make-store";

const { confirmAction } = vi.hoisted(() => ({ confirmAction: vi.fn() }));
vi.mock("@/lib/client/alerts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client/alerts")>()),
  confirmAction,
  enqueueNotification: vi.fn(() => () => {}),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

const NativeRequest = globalThis.Request;
let root: Root;
let container: HTMLDivElement;
let store: AppStore;
let requests: Request[];
let failedDeletions: number;
const category = {
  id: "category",
  name: "Office supplies",
  archived: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  requests = [];
  failedDeletions = 0;
  confirmAction.mockReset().mockResolvedValue(false);
  window.history.replaceState(null, "", "/daily-expenses");
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      requests.push(request);
      if (request.method === "DELETE") {
        if (failedDeletions-- > 0) throw new Error("Connection interrupted");
        return Response.json({
          success: true,
          data: { id: "expense", replayed: false },
        });
      }
      const pathname = new URL(request.url).pathname;
      const data = pathname.endsWith("/summary")
        ? {
            ledger: { id: "ledger", currency: "BDT", timezone: "Asia/Dhaka" },
            currentBalance: "80.00",
            totalBalanceAdded: "100.00",
            totalExpenses: "20.00",
            today: "2026-01-01",
          }
        : pathname.endsWith("/categories")
          ? [category]
          : {
              items: [
                {
                  id: "expense",
                  version: 1,
                  type: "EXPENSE",
                  amount: "20.00",
                  date: "2026-01-01",
                  note: "Printer paper",
                  category,
                  createdBy: {
                    id: "super-admin",
                    name: "Super Admin",
                    email: "super@example.test",
                  },
                  createdAt: "2026-01-01T00:00:00Z",
                },
              ],
              total: 26,
              page: 1,
              pageSize: 25,
              totalPages: 2,
            };
      return Response.json({ success: true, data });
    }),
  );
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

function button(text: string) {
  return [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text,
  );
}

async function render(role: string, locale: Locale = "en") {
  const messages = await loadMessages(locale);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale,
        timeZone: "Asia/Dhaka",
        messages,
        children: h(Provider, {
          store,
          children: h(DailyExpensesWorkspace, {
            canWrite: canWriteDailyExpenses(role),
            canEditTransactions: canEditDailyExpenseTransactions(role),
            canDeleteTransactions: canDeleteDailyExpenseTransactions(role),
            canDownloadReport: canDownloadDailyExpenseReport(role),
          }),
        }),
      }),
    );
  });
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Printer paper"),
    );
  });
}

it("keeps admin balances, history, filters, pagination, and refresh usable without write or export actions", async () => {
  await render("ADMIN");
  expect(container.textContent).toContain("Current Balance");
  expect(container.textContent).toContain(
    "Only super admins can make changes.",
  );
  expect(container.querySelector('[data-label="Category"]')?.textContent).toBe(
    "Office supplies",
  );
  for (const action of [
    "Add Balance",
    "Add Expense",
    "Categories",
    "Edit",
    "Delete",
    "Download PDF",
  ])
    expect(button(action)).toBeUndefined();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector('[data-label="Actions"]')).toBeNull();

  await act(async () => button("Next")!.click());
  expect(new URLSearchParams(window.location.search).get("page")).toBe("2");
  await act(async () => button("Apply filters")!.click());
  expect(new URLSearchParams(window.location.search).get("page")).toBe("1");
  await act(async () => button("Today")!.click());
  expect(new URLSearchParams(window.location.search).get("from")).toMatch(
    /^\d{4}-\d{2}-\d{2}$/,
  );
  await act(async () => button("Clear filters")!.click());
  expect(window.location.search).toBe("");
  const reads = requests.length;
  await act(async () => button("Refresh")!.click());
  await act(async () => {
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(reads));
  });
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});

it("retains all super admin transaction and category management controls", async () => {
  await render("SUPER_ADMIN");
  expect(button("Download PDF")).toBeDefined();
  for (const [action, title] of [
    ["Add Balance", "Add Balance"],
    ["Add Expense", "Add Expense"],
    ["Edit", "Edit Expense"],
    ["Categories", "Categories"],
  ]) {
    await act(async () => button(action)!.click());
    expect(
      container.querySelector('[role="dialog"]')?.getAttribute("aria-label"),
    ).toBe(title);
    if (action === "Categories") {
      expect(button("Create category")).toBeDefined();
      expect(button("Rename")).toBeDefined();
      expect(button("Archive")).toBeDefined();
    }
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!
        .click();
    });
  }
  expect(button("Delete")).toBeDefined();
});

it("reviews the exact transaction and balance impact in SweetAlert and cancels without deleting", async () => {
  await render("SUPER_ADMIN");
  await act(async () => button("Delete")!.click());
  expect(confirmAction).toHaveBeenCalledOnce();
  expect(confirmAction).toHaveBeenCalledWith({
    title: "Delete Expense",
    text: expect.stringContaining("Amount: BDT 20.00"),
    confirmText: "Delete record",
    cancelText: "Cancel",
    danger: true,
  });
  const review = confirmAction.mock.calls[0][0].text as string;
  for (const detail of [
    "Jan 1, 2026",
    "Office supplies",
    "Printer paper",
    "increase Current Balance by BDT 20.00",
    "permanently removed from the database",
  ])
    expect(review).toContain(detail);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it("prevents duplicate confirmations and submits only the reviewed version after acceptance", async () => {
  let resolveConfirmation!: (accepted: boolean) => void;
  confirmAction.mockImplementation(
    () => new Promise<boolean>((resolve) => (resolveConfirmation = resolve)),
  );
  await render("SUPER_ADMIN");
  await act(async () => {
    button("Delete")!.click();
    button("Delete")!.click();
  });
  expect(confirmAction).toHaveBeenCalledOnce();
  expect(button("Add Expense")?.disabled).toBe(true);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  await act(async () => resolveConfirmation(true));
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Expense deleted."),
    );
  });
  const deletions = requests.filter((request) => request.method === "DELETE");
  expect(deletions).toHaveLength(1);
  expect(await deletions[0].clone().json()).toEqual({ expectedVersion: 1 });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it("retains an uncertain deletion for Safe retry without another confirmation", async () => {
  confirmAction.mockResolvedValue(true);
  failedDeletions = 1;
  await render("SUPER_ADMIN");
  await act(async () => button("Delete")!.click());
  await act(async () => {
    await vi.waitFor(() => expect(button("Safe retry")).toBeDefined());
  });
  expect(
    container.querySelector('[role="dialog"]')?.getAttribute("aria-label"),
  ).toBe("Deletion recovery");
  expect(container.textContent).toContain("Printer paper");
  await act(async () => button("Safe retry")!.click());
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Expense deleted."),
    );
  });
  expect(confirmAction).toHaveBeenCalledOnce();
  const deletions = requests.filter((request) => request.method === "DELETE");
  expect(deletions).toHaveLength(2);
  expect(
    await Promise.all(deletions.map((request) => request.clone().json())),
  ).toEqual([{ expectedVersion: 1 }, { expectedVersion: 1 }]);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it("translates the read-only ledger in Chinese while preserving amounts and user content", async () => {
  await render("ADMIN", "zh-CN");
  expect(container.textContent).toContain("当前余额");
  expect(container.textContent).toContain("交易记录");
  expect(container.textContent).toContain("BDT 80.00");
  expect(container.textContent).toContain("Office supplies");
  expect(container.textContent).toContain("Printer paper");
  expect(button("新增支出")).toBeUndefined();
  expect(button("编辑")).toBeUndefined();
  expect(button("删除")).toBeUndefined();
});

it("keeps the route, filters and unsaved expense fields when the locale changes", async () => {
  window.history.replaceState(
    null,
    "",
    "/daily-expenses?search=Printer&page=2",
  );
  await render("SUPER_ADMIN");
  await act(async () => button("Add Expense")!.click());
  const amount = document.querySelector<HTMLInputElement>("#daily-amount")!;
  const note = document.querySelector<HTMLTextAreaElement>("#daily-note")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(amount, "123.45");
    amount.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(note, "Printer paper 纸张");
    note.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await render("SUPER_ADMIN", "zh-CN");
  expect(window.location.pathname + window.location.search).toBe(
    "/daily-expenses?search=Printer&page=2",
  );
  expect(document.querySelector<HTMLInputElement>("#daily-amount")!.value).toBe(
    "123.45",
  );
  expect(
    document.querySelector<HTMLTextAreaElement>("#daily-note")!.value,
  ).toBe("Printer paper 纸张");
  expect(document.querySelector<HTMLInputElement>("#daily-search")!.value).toBe(
    "Printer",
  );
  expect(document.body.textContent).toContain("保存支出");
  await render("SUPER_ADMIN", "en");
  expect(document.querySelector<HTMLInputElement>("#daily-amount")!.value).toBe(
    "123.45",
  );
  expect(document.body.textContent).toContain("Save expense");
});

async function fillInput(selector: string, value: string) {
  const element = document.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submitForm(selector: string) {
  await act(async () => {
    document
      .querySelector(selector)!
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

it("retranslates dynamic transaction success feedback in both directions", async () => {
  confirmAction.mockResolvedValue(true);
  await render("SUPER_ADMIN");
  await act(async () => button("Delete")!.click());
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "Expense deleted. Balances and history are being refreshed.",
      ),
    );
  });
  await render("SUPER_ADMIN", "zh-CN");
  expect(container.textContent).toContain(
    "支出已删除。正在刷新余额和交易记录。",
  );
  expect(container.textContent).not.toContain("Expense deleted.");
  await render("SUPER_ADMIN");
  expect(container.textContent).toContain(
    "Expense deleted. Balances and history are being refreshed.",
  );
});

it("retranslates persisted form and custom field errors without resubmitting", async () => {
  await render("SUPER_ADMIN");
  await act(async () => button("Add Expense")!.click());
  await fillInput("#daily-amount", "12.30");
  await submitForm("#daily-amount");
  expect(document.body.textContent).toContain("Choose a category.");
  expect(document.body.textContent).toContain(
    "Check the highlighted fields before saving.",
  );
  await render("SUPER_ADMIN", "zh-CN");
  expect(document.body.textContent).toContain("请选择一个类别。");
  expect(document.body.textContent).toContain(
    "请先检查标出的字段，然后再保存。",
  );
  expect(document.querySelector<HTMLInputElement>("#daily-amount")!.value).toBe(
    "12.30",
  );
  await render("SUPER_ADMIN");
  expect(document.body.textContent).toContain("Choose a category.");
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});

it("retranslates persisted filter errors while retaining the invalid draft dates", async () => {
  await render("ADMIN");
  await fillInput("#daily-from", "2026-01-02");
  await fillInput("#daily-to", "2026-01-01");
  await submitForm("#daily-from");
  expect(container.textContent).toContain(
    "The start date must be on or before the end date.",
  );
  await render("ADMIN", "zh-CN");
  expect(container.textContent).toContain("开始日期不能晚于结束日期。");
  expect(document.querySelector<HTMLInputElement>("#daily-from")!.value).toBe(
    "2026-01-02",
  );
  expect(document.querySelector<HTMLInputElement>("#daily-to")!.value).toBe(
    "2026-01-01",
  );
  await render("ADMIN");
  expect(container.textContent).toContain(
    "The start date must be on or before the end date.",
  );
});

it("retranslates persisted category validation without changing the category draft", async () => {
  await render("SUPER_ADMIN");
  await act(async () => button("Categories")!.click());
  await fillInput("#daily-category-name", "   ");
  await submitForm("#daily-category-name");
  expect(document.body.textContent).toContain("Enter a category name.");
  await render("SUPER_ADMIN", "zh-CN");
  expect(document.body.textContent).toContain("请输入类别名称。");
  expect(
    document.querySelector<HTMLInputElement>("#daily-category-name")!.value,
  ).toBe("   ");
  await render("SUPER_ADMIN");
  expect(document.body.textContent).toContain("Enter a category name.");
});
