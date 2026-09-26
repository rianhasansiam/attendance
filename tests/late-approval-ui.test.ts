// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider } from "react-redux";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LateReasonDialog } from "@/components/late-reason-dialog";
import { LateApprovalsWorkspace } from "@/components/late-approvals-workspace";
import { AttendanceStatus } from "@/components/ui";
import {
  makeStore,
  clearWorkspaceData,
  type AppStore,
} from "@/store/make-store";
import type { LateApprovalRequest } from "@/store/features/attendance/contracts";
import { attendanceApi } from "@/store/features/attendance/api";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

const NativeRequest = globalThis.Request;
let root: Root;
let container: HTMLDivElement;
let store: AppStore;
let request: LateApprovalRequest;
let writes: unknown[];
let rejectReads: boolean;
let failWrite: boolean;
let holdWrite: Promise<void> | undefined;

beforeEach(() => {
  writes = [];
  rejectReads = false;
  failWrite = false;
  holdWrite = undefined;
  window.history.replaceState(null, "", "/admin/late-approvals");
  request = {
    id: "request",
    attendanceId: "attendance",
    status: "PENDING",
    reason: "Train service was delayed.",
    lateMinutes: 30,
    checkInAt: "2026-09-24T03:00:00.000Z",
    scheduledStartAt: "2026-09-24T02:30:00.000Z",
    requestedAt: "2026-09-24T03:01:00.000Z",
    reviewedAt: null,
    reviewNote: null,
    reviewedBy: null,
    attendance: {
      id: "attendance",
      attendanceDate: "2026-09-24T00:00:00.000Z",
      checkInAt: "2026-09-24T03:00:00.000Z",
      lateMinutes: 30,
      employee: {
        id: "employee",
        employeeCode: "EMP-001",
        user: { name: "Employee One", email: "employee@example.test" },
      },
      shift: { timezone: "Asia/Dhaka" },
    },
  };
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
    vi.fn(async (http: Request) => {
      if (http.method !== "GET") {
        const body = await http.json();
        writes.push(body);
        await holdWrite;
        if (failWrite) {
          rejectReads = true;
          throw new TypeError("Network interrupted");
        }
        if (http.url.endsWith("/late-reason")) {
          return Response.json({
            success: true,
            data: {
              id: "attendance",
              lateReason: body.reason,
              lateApprovalStatus: body.requestApproval ? "PENDING" : null,
            },
          });
        }
        request = {
          ...request,
          status: body.status,
          reviewNote: body.reviewNote || null,
        };
        return Response.json({ success: true, data: request });
      }
      if (rejectReads)
        return Response.json({ success: false }, { status: 503 });
      const status = new URL(http.url).searchParams.get("status");
      const items = !status || request.status === status ? [request] : [];
      return Response.json({
        success: true,
        data: { items, total: items.length, page: 1, pageSize: 25 },
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
async function render(children: React.ReactNode) {
  await act(async () => root.render(h(Provider, { store, children })));
}

it("submits approval intent with the existing reason and no additional reason input", async () => {
  const onSaved = vi.fn();
  await render(
    h(LateReasonDialog, {
      attendance: { id: "attendance", lateMinutes: 30 },
      onClose: vi.fn(),
      onSaved,
    }),
  );
  expect(container.querySelectorAll("textarea")).toHaveLength(1);
  const reason = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(reason, "Train service was delayed.");
    reason.dispatchEvent(new Event("input", { bubbles: true }));
    container
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!
      .click();
  });
  await act(async () => button("Submit reason and request").click());
  await eventually(() =>
    expect(onSaved).toHaveBeenCalledWith({
      id: "attendance",
      lateReason: "Train service was delayed.",
      lateApprovalStatus: "PENDING",
    }),
  );
  expect(writes).toEqual([
    {
      attendanceId: "attendance",
      reason: "Train service was delayed.",
      requestApproval: true,
    },
  ]);
});

it("fences duplicate decisions and removes finalized requests from the pending view", async () => {
  let release!: () => void;
  holdWrite = new Promise<void>((resolve) => {
    release = resolve;
  });
  await render(h(LateApprovalsWorkspace));
  await eventually(() => expect(button("Review")).toBeDefined());
  expect(container.textContent).toContain("Train service was delayed.");
  expect(container.textContent).toContain("Asia/Dhaka");
  await act(async () => button("Review").click());
  const approve = button("Approve");
  await act(async () => {
    approve.click();
    approve.click();
  });
  await eventually(() => expect(writes).toHaveLength(1));
  expect(button("Reject").disabled).toBe(true);
  await act(async () => release());
  await eventually(() => {
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(button("Review")).toBeUndefined();
    expect(container.textContent).toContain("Late approval request approved.");
  });
  expect(writes).toEqual([{ status: "APPROVED" }]);
});

it("blocks further decisions until an uncertain write can be refreshed", async () => {
  failWrite = true;
  await render(h(LateApprovalsWorkspace));
  await eventually(() => expect(button("Review")).toBeDefined());
  await act(async () => button("Review").click());
  await act(async () => button("Reject").click());
  await eventually(() => {
    expect(writes).toHaveLength(1);
    expect(button("Approve").disabled).toBe(true);
    expect(container.textContent).toContain(
      "Refresh these requests successfully before another decision.",
    );
  });
  rejectReads = false;
  await act(async () => button("Refresh requests").click());
  await eventually(() => expect(button("Approve").disabled).toBe(false));
  expect(writes).toHaveLength(1);
});

it("shows effective, actual and approved late facts without offering another decision", async () => {
  window.history.replaceState(null, "", "/admin/late-approvals?status=all");
  request.status = "APPROVED";
  request.reviewedBy = {
    id: "admin",
    name: "Admin One",
    email: "admin@example.test",
  };
  request.reviewedAt = "2026-09-24T04:00:00.000Z";
  request.reviewNote = "Transport disruption confirmed.";
  await render(h(LateApprovalsWorkspace));
  await eventually(() => expect(button("View")).toBeDefined());
  await act(async () => button("View").click());
  expect(button("Approve")).toBeUndefined();
  expect(button("Reject")).toBeUndefined();
  expect(container.textContent).toContain("Admin One");
  expect(container.textContent).toContain("Transport disruption confirmed.");
  await render(
    h(AttendanceStatus, {
      record: {
        status: "PRESENT",
        actualStatus: "LATE",
        lateApprovalStatus: "APPROVED",
        isExcusedLate: true,
      },
    }),
  );
  expect(container.textContent).toContain("present");
  expect(container.textContent).toContain("Actual status: late");
  expect(container.textContent).toContain("Late approval: approved");
  expect(container.textContent).toContain("Excused late · not counted");
});

it("blocks approval of changed attendance and explains stale historical approval", async () => {
  request.attendance.lateMinutes = 45;
  await render(h(LateApprovalsWorkspace));
  await eventually(() => expect(button("Review")).toBeDefined());
  await act(async () => button("Review").click());
  expect(button("Approve").disabled).toBe(true);
  expect(button("Reject").disabled).toBe(false);
  expect(container.textContent).toContain("This request cannot be approved.");
  await render(
    h(AttendanceStatus, {
      record: {
        status: "LATE",
        actualStatus: "LATE",
        lateMinutes: 45,
        lateApprovalStatus: "APPROVED",
        isExcusedLate: false,
      },
    }),
  );
  expect(container.textContent).toContain(
    "Approval no longer matches attendance · late still counted",
  );
  expect(container.textContent).not.toContain("Excused late · not counted");
});

it("uses a new recovery read after an uncertain reason save instead of an older dashboard poll", async () => {
  let reads = 0;
  let releaseOld!: (response: Response) => void;
  const saved = {
    id: "attendance",
    lateReason: "Train service was delayed.",
    lateApprovalStatus: "PENDING",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (http: Request) => {
      if (http.method === "POST") {
        writes.push(await http.json());
        throw new TypeError("Response lost after commit");
      }
      reads++;
      if (reads === 1)
        return new Promise<Response>((resolve) => {
          releaseOld = resolve;
        });
      return Response.json({
        success: true,
        data: { today: saved, recent: [] },
      });
    }),
  );
  const poll = store.dispatch(
    attendanceApi.endpoints.employeeDay.initiate(undefined),
  );
  await vi.waitFor(() => expect(reads).toBe(1));
  const onSaved = vi.fn();
  await render(
    h(LateReasonDialog, {
      attendance: { id: "attendance", lateMinutes: 30 },
      onClose: vi.fn(),
      onSaved,
    }),
  );
  const reason = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(reason, saved.lateReason);
    reason.dispatchEvent(new Event("input", { bubbles: true }));
    container
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!
      .click();
  });
  await act(async () => button("Submit reason and request").click());
  await eventually(() =>
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(saved),
  );
  expect(reads).toBe(2);
  expect(writes).toHaveLength(1);
  await act(async () => {
    releaseOld(
      Response.json({
        success: true,
        data: { today: { id: "attendance", lateReason: null }, recent: [] },
      }),
    );
    await poll;
  });
  poll.unsubscribe();
  expect(onSaved).toHaveBeenCalledTimes(1);
});
