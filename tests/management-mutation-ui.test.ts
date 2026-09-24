// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider } from "react-redux";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminResource } from "@/components/resource-workspace";
import {
  makeStore,
  clearWorkspaceData,
  type AppStore,
} from "@/store/make-store";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
const NativeRequest = globalThis.Request;
let root: Root;
let container: HTMLDivElement;
let store: AppStore;
let writes = 0;
let rejectReads = false;

beforeEach(() => {
  writes = 0;
  rejectReads = false;
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
        writes++;
        rejectReads = true;
        throw new TypeError("Network interrupted");
      }
      if (rejectReads)
        return Response.json({ success: false }, { status: 503 });
      return Response.json({
        success: true,
        data: {
          items: [
            {
              id: "device",
              name: "Laptop",
              approved: false,
              revokedAt: null,
              employee: { user: { name: "Employee" } },
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
function button(text: string) {
  return [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text,
  )!;
}
async function eventually(assertion: () => void) {
  await act(async () => {
    await vi.waitFor(assertion);
  });
}

it("fences duplicate approval clicks and keeps writes disabled until an uncertain result can be refreshed", async () => {
  await act(async () => {
    root.render(
      h(Provider, {
        store,
        children: h(AdminResource, { resource: "devices" }),
      }),
    );
  });
  await eventually(() => expect(button("Approve")).toBeDefined());
  await act(async () => {
    button("Approve").click();
    button("Approve").click();
  });
  await eventually(() => {
    expect(writes).toBe(1);
    expect(button("Approve").disabled).toBe(true);
    expect(container.textContent).toContain(
      "Refresh these records successfully before trying another change.",
    );
  });
  rejectReads = false;
  await act(async () => {
    button("Refresh").click();
  });
  await eventually(() => expect(button("Approve").disabled).toBe(false));
  expect(writes).toBe(1);
});
