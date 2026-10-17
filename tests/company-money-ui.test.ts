// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider } from "react-redux";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyMoneyWorkspace } from "@/components/company-money-workspace";
import { loadMessages } from "@/i18n/messages";
import type { Locale } from "@/i18n/config";
import type { CompanyMoneyOverview } from "@/modules/company-money/contracts";
import { confirmAction } from "@/lib/client/alerts";
import enCommon from "../messages/en/common.json";
import zhCommon from "../messages/zh-CN/common.json";
import {
  clearWorkspaceData,
  makeStore,
  type AppStore,
} from "@/store/make-store";

vi.mock("@/lib/client/alerts", () => ({
  confirmAction: vi.fn(),
  enqueueNotification: vi.fn(() => () => {}),
  resetAlerts: vi.fn(),
}));

const NativeRequest = globalThis.Request;
let root: Root;
let container: HTMLDivElement;
let store: AppStore;
const overview: CompanyMoneyOverview = {
  balance: "90071992547409.93",
  totalAdded: "90071992547459.93",
  totalRemoved: "50.00",
  items: [
    {
      id: "transaction-1",
      version: 1,
      date: "2026-10-13",
      type: "ADD",
      amount: "100.00",
      note: "Initial company funds",
      createdAt: "2026-10-15T08:00:00.000Z",
      createdBy: { name: "Super Admin", email: "super@example.test" },
    },
  ],
  total: 21,
  page: 1,
  pageSize: 20,
};

function response(data: unknown) {
  return Response.json({ success: true, data });
}

function read(request: Request) {
  const page = Number(new URL(request.url).searchParams.get("page"));
  return response({
    ...overview,
    page,
    items:
      page === 1
        ? overview.items
        : [
            {
              ...overview.items[0],
              id: "transaction-21",
              date: "2026-09-30",
              type: "REMOVE",
              note: "Older removal",
              createdBy: null,
            },
          ],
  });
}

beforeEach(() => {
  vi.mocked(confirmAction).mockReset().mockResolvedValue(false);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T20:30:00.000Z"));
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
    vi.fn(async (request: Request) => read(request)),
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
  vi.useRealTimers();
});

async function render(
  canManage: boolean,
  locale: Locale = "en",
  timeZone = "Asia/Dhaka",
) {
  const messages = await loadMessages(locale);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale,
        timeZone,
        messages,
        children: h(Provider, {
          store,
          children: h(CompanyMoneyWorkspace, { canManage }),
        }),
      }),
    );
  });
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.textContent).toContain("৳90,071,992,547,409.93"),
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

async function selectRemoval() {
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>(
      'select[name="type"]',
    )!;
    select.value = "REMOVE";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function button(name: string) {
  const match = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find(
    (item) => (item.getAttribute("aria-label") || item.textContent) === name,
  );
  expect(match, `Missing button: ${name}`).toBeDefined();
  return match!;
}

async function click(name: string) {
  await act(async () => button(name).click());
}

describe("company money workspace", () => {
  it("shows exact balances and paginated history to admins without mutation controls", async () => {
    await render(false, "en", "America/Los_Angeles");
    expect(container.textContent).toContain("৳90,071,992,547,459.93");
    expect(container.textContent).toContain("৳50.00");
    expect(container.textContent).toContain("Initial company funds");
    expect(container.textContent).toContain("Super Admin");
    expect(container.textContent).toContain("view-only access");
    expect(container.querySelector("form")).toBeNull();
    expect(
      container.querySelector('[aria-label="Edit transaction"]'),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Delete transaction"]'),
    ).toBeNull();
    expect(container.querySelector("thead th")!.textContent).toBe(
      "Transaction date",
    );
    expect(container.querySelector("thead")!.textContent).toContain(
      "Recorded at",
    );
    const row = container.querySelector("tbody tr")!;
    expect(row.children[0].textContent).toBe("Oct 13, 2026");
    expect(row.children[1].textContent).toContain("Oct 15, 2026");
    expect(row.querySelector("time")!.dateTime).toBe("2026-10-13");

    await act(async () => {
      const next = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Next",
      )!;
      next.click();
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Older removal"),
      );
    });
    expect(container.textContent).not.toContain("Initial company funds");
    expect(container.textContent).toContain("Deleted user");
    expect(container.textContent).toContain("−৳100.00");
    expect(container.querySelector("tbody time")!.textContent).toBe(
      "Sep 30, 2026",
    );
  });

  it("defaults to the Dhaka date and retains a selected transaction date after success", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (request.method === "GET") return read(request);
        bodies.push(await request.json());
        return response({ id: `addition-${bodies.length}` });
      }),
    );
    await render(true, "en", "America/Los_Angeles");
    expect(input("date").type).toBe("date");
    expect(input("date").required).toBe(true);
    expect(input("date").value).toBe("2026-10-17");
    await fill("date", "2026-09-30");
    await fill("amount", "5.75");
    await submit();
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Balance added."),
      );
    });
    expect(bodies[0]).toMatchObject({
      date: "2026-09-30",
      type: "ADD",
      amount: "5.75",
    });
    expect(input("date").value).toBe("2026-09-30");
    await fill("amount", "1.25");
    await submit();
    await act(async () => {
      await vi.waitFor(() => expect(bodies).toHaveLength(2));
    });
    expect(bodies[1]).toMatchObject({ date: "2026-09-30", amount: "1.25" });
    expect(bodies[1].requestId).not.toBe(bodies[0].requestId);
  });

  it("keeps an uncertain removal frozen for an idempotent retry and blocks duplicate submits", async () => {
    const bodies: Record<string, unknown>[] = [];
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (request.method === "GET") return read(request);
        bodies.push(await request.json());
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }),
    );
    await render(true);
    await selectRemoval();
    await fill("date", "2026-10-01");
    await fill("amount", "12.50");
    await fill("note", "  Office purchase  ");
    await submit();
    await submit();
    await act(async () => {
      await vi.waitFor(() => expect(bodies).toHaveLength(1));
    });
    expect(bodies[0]).toEqual({
      requestId: expect.any(String),
      date: "2026-10-01",
      type: "REMOVE",
      amount: "12.50",
      note: "Office purchase",
    });
    expect(input("amount").disabled).toBe(true);
    expect(input("date").disabled).toBe(true);
    await act(async () => {
      finish(
        Response.json(
          { success: false, error: { code: "FAILED", message: "Interrupted" } },
          { status: 500 },
        ),
      );
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Retry transaction"),
      );
    });
    expect(input("note").disabled).toBe(true);
    expect(input("date").disabled).toBe(true);
    expect(input("date").value).toBe("2026-10-01");
    expect(container.querySelector("select")!.disabled).toBe(true);
    await submit();
    await act(async () => {
      await vi.waitFor(() => expect(bodies).toHaveLength(2));
    });
    expect(bodies[1]).toEqual(bodies[0]);
    await act(async () => finish(response({ id: "removed-1" })));
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Balance removed."),
      );
    });
    expect(input("amount").disabled).toBe(false);
    expect(input("amount").value).toBe("");
    expect(input("note").value).toBe("");
    expect(input("date").disabled).toBe(false);
    expect(input("date").value).toBe("2026-10-01");

    await fill("amount", "1.00");
    await submit();
    await act(async () => {
      await vi.waitFor(() => expect(bodies).toHaveLength(3));
    });
    expect(bodies[2].requestId).not.toBe(bodies[0].requestId);
    await act(async () => finish(response({ id: "removed-2" })));
  });

  it.each(["0", "-1", "1.001", "10000000000"])(
    "rejects the invalid amount %s before sending a transaction",
    async (amount) => {
      await render(true);
      await fill("amount", amount);
      await submit();
      expect(container.textContent).toContain(
        "Enter an amount greater than zero",
      );
      expect(
        vi
          .mocked(fetch)
          .mock.calls.every(
            ([request]) => (request as Request).method === "GET",
          ),
      ).toBe(true);
    },
  );

  it.each(["", "2026-02-30", "0000-12-31"])(
    "rejects an invalid transaction date %s before sending a transaction",
    async (date) => {
      await render(true);
      await fill("date", date);
      await fill("amount", "1.00");
      await submit();
      expect(container.textContent).toContain(
        "Choose a valid transaction date.",
      );
      expect(
        vi
          .mocked(fetch)
          .mock.calls.every(
            ([request]) => (request as Request).method === "GET",
          ),
      ).toBe(true);
    },
  );

  it("unlocks an uncertain withdrawal after a retry confirms insufficient funds", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (request.method === "GET") return read(request);
        bodies.push(await request.json());
        return bodies.length <= 2
          ? Response.json(
              {
                success: false,
                error: {
                  code:
                    bodies.length === 1
                      ? "FAILED"
                      : "INSUFFICIENT_COMPANY_BALANCE",
                  message: "Transaction failed",
                },
              },
              { status: bodies.length === 1 ? 500 : 409 },
            )
          : response({ id: "smaller-removal" });
      }),
    );
    await render(true);
    await selectRemoval();
    await fill("amount", "100.00");
    await submit();
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Retry transaction"),
      );
    });
    await submit();
    await act(async () => {
      await vi.waitFor(() => expect(input("amount").disabled).toBe(false));
    });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(container.textContent).not.toContain("Retry transaction");
    expect(container.textContent).toContain(
      enCommon.errors.INSUFFICIENT_COMPANY_BALANCE,
    );
    await fill("amount", "1.00");
    await submit();
    await act(async () => {
      await vi.waitFor(() => expect(bodies).toHaveLength(3));
    });
    expect(bodies[2].requestId).not.toBe(bodies[0].requestId);
    expect(bodies[2].amount).toBe("1.00");
  });

  it("preserves the form and raw error identity when switching language", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) =>
        request.method === "GET"
          ? read(request)
          : Response.json(
              {
                success: false,
                error: {
                  code: "INSUFFICIENT_COMPANY_BALANCE",
                  message: "Insufficient company balance.",
                },
              },
              { status: 409 },
            ),
      ),
    );
    await render(true);
    await selectRemoval();
    await fill("date", "2026-08-31");
    await fill("amount", "12.50");
    await fill("note", "Office supplies 办公用品");
    await submit();
    await act(async () => {
      await vi.waitFor(() => expect(input("amount").disabled).toBe(false));
    });
    await render(true, "zh-CN");
    expect(container.textContent).toContain("公司资金");
    expect(container.textContent).toContain("金额（BDT）");
    expect(container.textContent).toContain("交易日期");
    expect(input("date").value).toBe("2026-08-31");
    expect(input("amount").value).toBe("12.50");
    expect(input("note").value).toBe("Office supplies 办公用品");
    expect(container.querySelector("select")!.value).toBe("REMOVE");
    expect(container.textContent).toContain(
      zhCommon.errors.INSUFFICIENT_COMPANY_BALANCE,
    );
    expect(container.textContent).not.toContain(
      enCommon.errors.INSUFFICIENT_COMPANY_BALANCE,
    );
  });
});

describe("company money transaction changes", () => {
  it("edits all fields with the record version and restores the existing creation draft", async () => {
    const writes: {
      method: string;
      url: string;
      body: Record<string, unknown>;
    }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (request.method === "GET") return read(request);
        const body = await request.json();
        writes.push({
          method: request.method,
          url: new URL(request.url).pathname,
          body,
        });
        return response({ ...overview.items[0], ...body, version: 2 });
      }),
    );
    await render(true);
    await fill("date", "2026-10-10");
    await fill("amount", "22.00");
    await fill("note", "Draft addition");
    await click("Edit transaction");
    expect(
      container.querySelector('form[aria-label="Edit transaction"]'),
    ).not.toBeNull();
    expect(input("date").value).toBe("2026-10-13");
    expect(input("amount").value).toBe("100.00");
    expect(input("note").value).toBe("Initial company funds");
    await selectRemoval();
    await fill("date", "2026-09-01");
    await fill("amount", "75.25");
    await fill("note", "  Corrected funds  ");
    await submit();
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Transaction updated."),
      );
    });
    expect(writes).toEqual([
      {
        method: "PATCH",
        url: "/api/admin/company-money/transaction-1",
        body: {
          requestId: expect.any(String),
          expectedVersion: 1,
          type: "REMOVE",
          amount: "75.25",
          date: "2026-09-01",
          note: "Corrected funds",
        },
      },
    ]);
    expect(
      container.querySelector('form[aria-label="Edit transaction"]'),
    ).toBeNull();
    expect(input("date").value).toBe("2026-10-10");
    expect(input("amount").value).toBe("22.00");
    expect(input("note").value).toBe("Draft addition");
    expect(container.querySelector("select")!.value).toBe("ADD");
  });

  it("cancels an edit without writing and retains the creation draft", async () => {
    await render(true);
    await fill("amount", "23.50");
    await fill("note", "Unsubmitted addition");
    await click("Edit transaction");
    await fill("amount", "7.50");
    await fill("note", "Unsubmitted edit");
    await click("Cancel edit");
    expect(input("amount").value).toBe("23.50");
    expect(input("note").value).toBe("Unsubmitted addition");
    expect(
      container.querySelector('form[aria-label="Edit transaction"]'),
    ).toBeNull();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.every(([request]) => (request as Request).method === "GET"),
    ).toBe(true);
  });

  it("keeps the complete uncertain edit frozen and retries the same request once", async () => {
    const bodies: Record<string, unknown>[] = [];
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (request.method === "GET") return read(request);
        expect(request.method).toBe("PATCH");
        bodies.push(await request.json());
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }),
    );
    await render(true);
    await click("Edit transaction");
    await fill("date", "2034-02-04");
    await fill("amount", "125.75");
    await fill("note", "Edited allocation");
    await submit();
    await submit();
    await act(async () => {
      await vi.waitFor(() => expect(bodies).toHaveLength(1));
    });
    expect(bodies[0]).toMatchObject({
      expectedVersion: 1,
      date: "2034-02-04",
      amount: "125.75",
      note: "Edited allocation",
    });
    await act(async () =>
      finish(Response.json({ success: false }, { status: 500 })),
    );
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Retry transaction"),
      );
    });
    expect(input("date").disabled).toBe(true);
    expect(input("note").disabled).toBe(true);
    expect(button("Cancel edit").disabled).toBe(true);
    expect(button("Delete transaction").disabled).toBe(true);
    await submit();
    await submit();
    await act(async () => {
      await vi.waitFor(() => expect(bodies).toHaveLength(2));
    });
    expect(bodies[1]).toEqual(bodies[0]);
    await act(async () =>
      finish(response({ ...overview.items[0], version: 2 })),
    );
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Transaction updated."),
      );
    });
    expect(input("amount").disabled).toBe(false);
    expect(input("amount").value).toBe("");
  });

  it.each(["TRANSACTION_CONFLICT", "TRANSACTION_DELETED"] as const)(
    "discards a stale uncertain edit after the server confirms %s",
    async (code) => {
      let writes = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: Request) => {
          if (request.method === "GET") return read(request);
          writes++;
          return Response.json(
            { success: false, error: { code, message: "Rejected" } },
            { status: writes === 1 ? 500 : 409 },
          );
        }),
      );
      await render(true);
      await fill("amount", "23.00");
      await click("Edit transaction");
      await fill("amount", "120.00");
      await submit();
      await act(async () => {
        await vi.waitFor(() =>
          expect(container.textContent).toContain("Retry transaction"),
        );
      });
      await submit();
      await act(async () => {
        await vi.waitFor(() => expect(input("amount").disabled).toBe(false));
      });
      expect(writes).toBe(2);
      expect(container.textContent).toContain(enCommon.errors[code]);
      expect(container.textContent).not.toContain("Retry transaction");
      expect(
        container.querySelector('form[aria-label="Edit transaction"]'),
      ).toBeNull();
      expect(input("amount").value).toBe("23.00");
    },
  );

  it.each(["ADD", "REMOVE"] as const)(
    "reviews the %s deletion balance effect and only deletes after confirmation",
    async (type) => {
      const record = { ...overview.items[0], type };
      const bodies: Record<string, unknown>[] = [];
      let deleted = false;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: Request) => {
          if (request.method === "GET")
            return response({
              ...overview,
              total: deleted ? 0 : 1,
              items: deleted ? [] : [record],
            });
          expect(request.method).toBe("DELETE");
          expect(new URL(request.url).pathname).toBe(
            "/api/admin/company-money/transaction-1",
          );
          bodies.push(await request.json());
          deleted = true;
          return response({ id: record.id });
        }),
      );
      await render(true);
      await click("Delete transaction");
      expect(confirmAction).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Delete transaction?",
          confirmText: "Delete transaction",
          cancelText: "Cancel",
          danger: true,
        }),
      );
      const confirmation = vi.mocked(confirmAction).mock.calls[0][0];
      expect(confirmation.text).toContain("৳100.00");
      expect(confirmation.text).toContain("Oct 13, 2026");
      expect(confirmation.text).toContain(
        type === "ADD" ? "reduce the company balance" : "restore ৳100.00",
      );
      expect(bodies).toHaveLength(0);
      vi.mocked(confirmAction).mockResolvedValueOnce(true);
      await click("Delete transaction");
      await act(async () => {
        await vi.waitFor(() =>
          expect(container.textContent).toContain("Transaction deleted."),
        );
      });
      expect(bodies).toEqual([
        { requestId: expect.any(String), expectedVersion: 1 },
      ]);
      expect(container.querySelector("tbody")).toBeNull();
    },
  );

  it("retries a deleted row with its frozen UUID and version after an uncertain response", async () => {
    const bodies: Record<string, unknown>[] = [];
    let deleted = false;
    vi.mocked(confirmAction).mockResolvedValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (request.method === "GET")
          return response({
            ...overview,
            total: deleted ? 0 : 1,
            items: deleted ? [] : overview.items,
          });
        expect(request.method).toBe("DELETE");
        bodies.push(await request.json());
        deleted = true;
        return bodies.length === 1
          ? Response.json({ success: false }, { status: 500 })
          : response({ id: "transaction-1" });
      }),
    );
    await render(true);
    await fill("amount", "35.00");
    await fill("note", "Keep this draft");
    await click("Delete transaction");
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Retry deletion"),
      );
    });
    expect(container.querySelector("tbody")).toBeNull();
    expect(input("amount").disabled).toBe(true);
    await submit();
    expect(bodies).toHaveLength(1);
    await act(async () => {
      const retry = button("Retry deletion");
      retry.click();
      retry.click();
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Transaction deleted."),
      );
    });
    expect(confirmAction).toHaveBeenCalledOnce();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(input("amount").disabled).toBe(false);
    expect(input("amount").value).toBe("35.00");
    expect(input("note").value).toBe("Keep this draft");
  });

  it("returns to the previous page after deleting its final row", async () => {
    let deleted = false;
    vi.mocked(confirmAction).mockResolvedValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (request.method === "GET") {
          const page = Number(new URL(request.url).searchParams.get("page"));
          if (deleted && page === 2)
            return response({ ...overview, page, total: 20, items: [] });
          return read(request);
        }
        deleted = true;
        return response({ id: "transaction-21" });
      }),
    );
    await render(true);
    await click("Next");
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Older removal"),
      );
    });
    await click("Delete transaction");
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Initial company funds"),
      );
    });
    expect(container.textContent).not.toContain("Older removal");
    expect(button("Previous").disabled).toBe(true);
  });
});
