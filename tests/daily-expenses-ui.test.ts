// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider } from "react-redux";
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

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

const NativeRequest = globalThis.Request;
let root: Root;
let container: HTMLDivElement;
let store: AppStore;
let requests: Request[];
const category = {
  id: "category",
  name: "Office supplies",
  archived: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  requests = [];
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

async function render(role: string) {
  await act(async () => {
    root.render(
      h(Provider, {
        store,
        children: h(DailyExpensesWorkspace, {
          canWrite: canWriteDailyExpenses(role),
          canEditTransactions: canEditDailyExpenseTransactions(role),
          canDeleteTransactions: canDeleteDailyExpenseTransactions(role),
          canDownloadReport: canDownloadDailyExpenseReport(role),
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
    ["Delete", "Delete Expense"],
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
});
