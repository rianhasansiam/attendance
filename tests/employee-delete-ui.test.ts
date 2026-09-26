// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider } from "react-redux";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminResource } from "@/components/resource-workspace";
import { confirmAction } from "@/lib/client/alerts";
import {
  makeStore,
  clearWorkspaceData,
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
const confirmation =
  "Permanently delete this employee and their sign-in account? This cannot be undone. Related records will be kept with the employee’s details replaced by “deleted info”.";
let root: Root;
let container: HTMLDivElement;
let store: AppStore;
let writes: Request[];
let rejectReads: boolean;
let deletion: (request: Request) => Promise<Response>;
let employees: ReturnType<typeof employee>[];

function employee(id: string, role = "EMPLOYEE", status = "ACTIVE") {
  return {
    id,
    employeeCode: id,
    user: {
      id: `user-${id}`,
      name: id,
      email: `${id}@example.test`,
      role,
      status,
    },
    office: { name: "Office" },
  };
}

beforeEach(() => {
  writes = [];
  rejectReads = false;
  employees = [employee("employee")];
  deletion = async () => {
    const [{ id }] = employees;
    employees = [];
    return Response.json({ success: true, data: { id } });
  };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(confirmAction).mockReset().mockResolvedValue(true);
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
        return deletion(request);
      }
      if (rejectReads)
        return Response.json({ success: false }, { status: 503 });
      return Response.json({
        success: true,
        data: {
          items: employees,
          total: employees.length,
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deleteButtons() {
  return [
    ...container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Delete employee"]',
    ),
  ];
}

async function eventually(assertion: () => void) {
  await act(async () => {
    await vi.waitFor(assertion);
  });
}

async function render(canDeleteEmployees?: boolean) {
  await act(async () => {
    root.render(
      h(Provider, {
        store,
        children: h(AdminResource, {
          resource: "employees",
          canDeleteEmployees,
        }),
      }),
    );
  });
  await eventually(() =>
    expect(
      container.querySelectorAll('button[aria-label="Edit employee"]'),
    ).toHaveLength(employees.length),
  );
}

it.each([undefined, false])(
  "keeps employee editing available but hides deletion without permission (%s)",
  async (permission) => {
    await render(permission);
    expect(deleteButtons()).toHaveLength(0);
    expect(writes).toHaveLength(0);
  },
);

it("shows deletion for active, inactive and suspended employee and driver-manager accounts", async () => {
  employees = [
    employee("employee"),
    employee("driver-manager", "MANAGE_DRIVER"),
    employee("suspended", "EMPLOYEE", "SUSPENDED"),
    employee("inactive", "EMPLOYEE", "INACTIVE"),
    employee("administrator", "ADMIN"),
    employee("super-administrator", "SUPER_ADMIN"),
  ];
  await render(true);
  expect(
    deleteButtons().map((button) => button.closest("tr")?.textContent),
  ).toEqual([
    expect.stringContaining("employee@example.test"),
    expect.stringContaining("driver-manager@example.test"),
    expect.stringContaining("suspended@example.test"),
    expect.stringContaining("inactive@example.test"),
  ]);
});

it("links active employees to their user public profile and hides unavailable profiles", async () => {
  employees = [
    employee("employee"),
    employee("administrator", "ADMIN"),
    employee("inactive", "EMPLOYEE", "INACTIVE"),
    employee("suspended", "EMPLOYEE", "SUSPENDED"),
    employee("missing-user"),
    employee("missing-user-id"),
  ];
  Reflect.deleteProperty(employees[4], "user");
  Reflect.deleteProperty(employees[5].user, "id");
  await render();

  const links = [
    ...container.querySelectorAll<HTMLAnchorElement>(
      'a[aria-label="View public profile (opens in new tab)"]',
    ),
  ];
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "/profile/user-employee",
    "/profile/user-administrator",
  ]);
  for (const link of links) {
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
  }
  expect(writes).toHaveLength(0);
});

it("explains permanent account deletion and preserves the employee when confirmation is cancelled", async () => {
  vi.mocked(confirmAction).mockResolvedValue(false);
  await render(true);
  await act(async () => deleteButtons()[0].click());
  expect(confirmAction).toHaveBeenCalledWith({
    title: "Delete employee?",
    text: confirmation,
    confirmText: "Delete employee",
    danger: true,
  });
  expect(writes).toHaveLength(0);
  expect(deleteButtons()[0].disabled).toBe(false);
});

it("opens one confirmation on rapid clicks and sends no request until confirmed", async () => {
  let confirm!: (value: boolean) => void;
  vi.mocked(confirmAction).mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        confirm = resolve;
      }),
  );
  await render(true);
  await act(async () => {
    deleteButtons()[0].click();
    deleteButtons()[0].click();
  });
  expect(confirmAction).toHaveBeenCalledTimes(1);
  expect(writes).toHaveLength(0);
  expect(deleteButtons()[0].disabled).toBe(true);
  await act(async () => confirm(false));
  expect(writes).toHaveLength(0);
  expect(deleteButtons()[0].disabled).toBe(false);
});

it("sends one DELETE while pending and removes the employee from the refreshed list after success", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  deletion = async () => {
    await pending;
    const [{ id }] = employees;
    employees = [];
    return Response.json({ success: true, data: { id } });
  };
  await render(true);
  await act(async () => {
    deleteButtons()[0].click();
    deleteButtons()[0].click();
  });
  await eventually(() => {
    expect(writes).toHaveLength(1);
    expect(deleteButtons()[0].disabled).toBe(true);
  });
  expect(writes[0].method).toBe("DELETE");
  expect(new URL(writes[0].url).pathname).toBe("/api/admin/employees/employee");
  await act(async () => finish());
  await eventually(() => {
    expect(container.textContent).toContain(
      "Employee and sign-in account permanently deleted.",
    );
    expect(container.textContent).not.toContain("employee@example.test");
    expect(deleteButtons()).toHaveLength(0);
  });
});

it("blocks a repeated deletion after a lost response until authoritative refresh succeeds", async () => {
  deletion = async () => {
    employees = [];
    rejectReads = true;
    throw new TypeError("Network interrupted");
  };
  await render(true);
  await act(async () => deleteButtons()[0].click());
  await eventually(() => {
    expect(writes).toHaveLength(1);
    expect(deleteButtons()[0].disabled).toBe(true);
    expect(container.textContent).toContain(
      "Refresh these records successfully before trying another change.",
    );
  });
  rejectReads = false;
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Refresh")!
      .click();
  });
  await eventually(() => {
    expect(container.textContent).not.toContain("employee@example.test");
    expect(deleteButtons()).toHaveLength(0);
  });
  expect(writes).toHaveLength(1);
});

it("keeps a confirmed deletion out of a stale list and corrects its count when refresh fails", async () => {
  employees = [employee("employee"), employee("retained")];
  deletion = async () => {
    const [{ id }] = employees;
    employees = employees.slice(1);
    rejectReads = true;
    return Response.json({ success: true, data: { id } });
  };
  await render(true);
  await act(async () => deleteButtons()[0].click());
  await eventually(() => {
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Refresh failed. Showing previously loaded data.",
    );
    expect(container.textContent).toContain(
      "Employee and sign-in account permanently deleted.",
    );
    expect(container.textContent).not.toContain("employee@example.test");
    expect(container.textContent).toContain("retained@example.test");
    expect(deleteButtons()).toHaveLength(1);
    expect(
      container.querySelectorAll('button[aria-label="Edit employee"]'),
    ).toHaveLength(1);
    expect(
      container.querySelector('.toolbar [role="status"]')?.textContent,
    ).toBe("1 records");
    expect(container.querySelector(".pagination")?.textContent).toContain(
      "1 total records",
    );
  });
  rejectReads = false;
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Refresh")!
      .click();
  });
  await eventually(() => {
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(
      container.querySelector('.toolbar [role="status"]')?.textContent,
    ).toBe("1 records");
    expect(deleteButtons()).toHaveLength(1);
  });
  expect(writes).toHaveLength(1);
});

it("keeps the employee visible and shows the server explanation when a concurrent change prevents deletion", async () => {
  const message =
    "This employee changed while deletion was in progress. Please refresh and try again.";
  deletion = async () =>
    Response.json(
      { success: false, error: { code: "CONFLICT", message } },
      { status: 409 },
    );
  await render(true);
  await act(async () => deleteButtons()[0].click());
  await eventually(() => {
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      message,
    );
    expect(container.textContent).toContain("employee@example.test");
    expect(deleteButtons()[0].disabled).toBe(false);
  });
  expect(writes).toHaveLength(1);
});
