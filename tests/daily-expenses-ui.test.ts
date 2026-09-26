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
    danger: true,
  });
  const review = confirmAction.mock.calls[0][0].text as string;
  for (const detail of [
    "1 Jan 2026",
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
