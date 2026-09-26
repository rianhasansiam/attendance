// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider } from "react-redux";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminResource } from "@/components/resource-workspace";
import { confirmAction, promptAction } from "@/lib/client/alerts";
import {
  clearWorkspaceData,
  makeStore,
  type AppStore,
} from "@/store/make-store";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/client/alerts", () => ({
  confirmAction: vi.fn(),
  promptAction: vi.fn(),
  enqueueNotification: vi.fn(() => () => {}),
}));

const NativeRequest = globalThis.Request;
let root: Root;
let container: HTMLDivElement;
let store: AppStore;
let writes: Request[];

beforeEach(() => {
  writes = [];
  vi.mocked(confirmAction).mockReset().mockResolvedValue(true);
  vi.mocked(promptAction).mockReset().mockResolvedValue("");
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
      if (request.method !== "GET") {
        writes.push(request);
        return Response.json({ success: true, data: { id: "record" } });
      }
      return Response.json({
        success: true,
        data: {
          items: [
            {
              id: "record",
              employee: { user: { name: "Employee" } },
              name: "Laptop",
              approved: false,
              revokedAt: null,
              status: "PENDING",
              startDate: "2026-10-01",
              endDate: "2026-10-01",
              reason: "Appointment",
            },
          ],
          total: 1,
          page: 1,
          pageSize: 25,
        },
      });
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

function button(name: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === name,
  )!;
}
async function eventually(assertion: () => void) {
  await act(async () => {
    await vi.waitFor(assertion);
  });
}
async function render(resource: "devices" | "leaves") {
  await act(async () =>
    root.render(
      h(Provider, {
        store,
        children: h(AdminResource, { resource }),
      }),
    ),
  );
  await eventually(() => expect(button("Approve")).toBeDefined());
}

it.each([false, true])(
  "requires an explicit device revocation confirmation (%s)",
  async (confirmed) => {
    vi.mocked(confirmAction).mockResolvedValue(confirmed);
    await render("devices");
    await act(async () => button("Revoke").click());
    expect(confirmAction).toHaveBeenCalledWith({
      title: "Revoke device?",
      text: "It will no longer verify attendance.",
      confirmText: "Revoke device",
      danger: true,
    });
    if (confirmed) {
      await eventually(() => expect(writes).toHaveLength(1));
      expect(await writes[0].clone().json()).toEqual({ revoked: true });
    } else {
      expect(writes).toHaveLength(0);
      expect(button("Revoke").disabled).toBe(false);
    }
  },
);

it.each(["Approve", "Decline"])(
  "cancelling %s leaves the request unchanged",
  async (decision) => {
    vi.mocked(promptAction).mockResolvedValue(null);
    await render("leaves");
    await act(async () => button(decision).click());
    expect(promptAction).toHaveBeenCalledWith({
      title: `${decision} leave?`,
      inputLabel: "Review note (optional)",
      initialValue: "",
      confirmText: `${decision} leave`,
      maxLength: 1000,
    });
    expect(writes).toHaveLength(0);
    expect(button(decision).disabled).toBe(false);
  },
);

it.each([
  ["Approve", "APPROVED", ""],
  ["Decline", "REJECTED", "Please select another date."],
])(
  "submits %s with its accepted optional review note",
  async (decision, status, note) => {
    vi.mocked(promptAction).mockResolvedValue(note);
    await render("leaves");
    await act(async () => button(decision).click());
    await eventually(() => expect(writes).toHaveLength(1));
    expect(writes[0].method).toBe("PATCH");
    expect(await writes[0].clone().json()).toEqual({
      status,
      reviewNote: note,
    });
  },
);

it("keeps one pending review prompt and makes no write until it is accepted", async () => {
  let finish!: (value: string | null) => void;
  vi.mocked(promptAction).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render("leaves");
  await act(async () => {
    button("Approve").click();
    button("Decline").click();
  });
  expect(promptAction).toHaveBeenCalledTimes(1);
  expect(writes).toHaveLength(0);
  expect(button("Approve").disabled).toBe(true);
  expect(button("Decline").disabled).toBe(true);
  await act(async () => finish(""));
  await eventually(() => expect(writes).toHaveLength(1));
  expect(await writes[0].clone().json()).toEqual({
    status: "APPROVED",
    reviewNote: "",
  });
});
