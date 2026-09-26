// @vitest-environment jsdom
import { act, createElement as h, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider } from "react-redux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EmployeeDevices,
  EmployeeLeaves,
} from "@/components/employee-workspace";
import { DriveCostWorkspace } from "@/components/drive-cost-workspace";
import { confirmAction } from "@/lib/client/alerts";
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
  enqueueNotification: vi.fn(() => () => {}),
  resetAlerts: vi.fn(),
}));

const NativeRequest = globalThis.Request;
let root: Root;
let container: HTMLDivElement;
let store: AppStore;
let writes: Request[];
let finishConfirmation: (confirmed: boolean) => void;
let finishWrite: (response: Response) => void;

const cases = [
  {
    name: "employee device revocation",
    Component: EmployeeDevices,
    button: "Revoke",
    title: "Revoke this device?",
    path: "/api/webauthn/devices",
    success: "Device revoked successfully.",
  },
  {
    name: "employee leave cancellation",
    Component: EmployeeLeaves,
    button: "Cancel request",
    title: "Cancel this leave request?",
    path: "/api/employee/leaves/record",
    success: "Your leave request has been cancelled.",
  },
  {
    name: "drive cost deletion",
    Component: DriveCostWorkspace,
    button: "Delete drive cost from Office to Client site",
    title: "Delete this drive cost?",
    path: "/api/admin/drive-costs/record",
    success: "Drive cost deleted successfully.",
  },
];

beforeEach(() => {
  writes = [];
  vi.mocked(confirmAction)
    .mockReset()
    .mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishConfirmation = resolve;
        }),
    );
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
        return new Promise<Response>((resolve) => {
          finishWrite = resolve;
        });
      }
      return Response.json({
        success: true,
        data: {
          items: [
            {
              id: "record",
              name: "Laptop",
              createdAt: "2026-09-26T06:00:00.000Z",
              approved: true,
              revokedAt: null,
              status: "PENDING",
              startDate: "2026-10-01",
              endDate: "2026-10-02",
              reason: "Time away",
              date: "2026-09-26",
              destinationFrom: "Office",
              destinationTo: "Client site",
              kilometers: "10.00",
              rateType: "IN_TIME",
              ratePerKilometer: "5.00",
              totalCost: "50.00",
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
  return [...container.querySelectorAll("button")].find(
    (item) =>
      (item.getAttribute("aria-label") || item.textContent?.trim()) === name,
  )!;
}

async function eventually(assertion: () => void) {
  await act(async () => {
    await vi.waitFor(assertion);
  });
}

async function render(Component: ComponentType, name: string) {
  await act(async () => {
    root.render(h(Provider, { store, children: h(Component) }));
  });
  await eventually(() => expect(button(name)).toBeDefined());
}

for (const scenario of cases) {
  describe(scenario.name, () => {
    it("does not write before confirmation or after cancellation, and permits another attempt", async () => {
      await render(scenario.Component, scenario.button);
      await act(async () => {
        button(scenario.button).click();
        button(scenario.button).click();
      });
      expect(confirmAction).toHaveBeenCalledTimes(1);
      expect(confirmAction).toHaveBeenCalledWith(
        expect.objectContaining({ title: scenario.title }),
      );
      expect(button(scenario.button).disabled).toBe(true);
      expect(writes).toHaveLength(0);
      await act(async () => finishConfirmation(false));
      expect(button(scenario.button).disabled).toBe(false);
      expect(writes).toHaveLength(0);
      await act(async () => button(scenario.button).click());
      expect(confirmAction).toHaveBeenCalledTimes(2);
      await act(async () => finishConfirmation(false));
      expect(writes).toHaveLength(0);
    });

    it("submits once after confirmation and keeps the operation fenced until its response", async () => {
      await render(scenario.Component, scenario.button);
      await act(async () => button(scenario.button).click());
      expect(writes).toHaveLength(0);
      await act(async () => finishConfirmation(true));
      await eventually(() => expect(writes).toHaveLength(1));
      expect(writes[0].method).toBe("DELETE");
      expect(new URL(writes[0].url).pathname).toBe(scenario.path);
      await act(async () => button(scenario.button).click());
      expect(confirmAction).toHaveBeenCalledTimes(1);
      expect(writes).toHaveLength(1);
      await act(async () =>
        finishWrite(Response.json({ success: true, data: { id: "record" } })),
      );
      await eventually(() => {
        expect(button(scenario.button).disabled).toBe(false);
        expect(container.textContent).toContain(scenario.success);
      });
    });
  });
}
