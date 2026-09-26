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
let root: Root;
let container: HTMLDivElement;
let store: AppStore;
let writes: Request[];
let rejectReads: boolean;
let mutation: (request: Request) => Promise<Response>;
let users: ReturnType<typeof user>[];

function user(id: string, role = "EMPLOYEE", hasProfile = true) {
  return {
    id,
    name: id,
    email: `${id}@example.test`,
    role,
    status: "ACTIVE",
    employee: hasProfile ? { id: `employee-${id}`, employeeCode: id } : null,
  };
}

beforeEach(() => {
  writes = [];
  rejectReads = false;
  users = [user("employee")];
  mutation = async (request) => {
    const id = new URL(request.url).pathname.split("/").at(-1)!;
    if (request.method === "DELETE")
      users = users.filter((row) => row.id !== id);
    else {
      const body = await request.clone().json();
      users = users.map((row) => (row.id === id ? { ...row, ...body } : row));
    }
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
        return mutation(request);
      }
      if (rejectReads)
        return Response.json({ success: false }, { status: 503 });
      return Response.json({
        success: true,
        data: { items: users, total: users.length, page: 1, pageSize: 25 },
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

function buttons(label: string) {
  return [
    ...container.querySelectorAll<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    ),
  ];
}
async function eventually(assertion: () => void) {
  await act(async () => {
    await vi.waitFor(assertion);
  });
}
async function render(canEditPublicProfiles = false) {
  await act(async () =>
    root.render(
      h(Provider, {
        store,
        children: h(AdminResource, {
          resource: "users",
          currentUserId: "current-super-admin",
          canEditPublicProfiles,
        }),
      }),
    ),
  );
  await eventually(() =>
    expect(buttons("Edit user")).toHaveLength(users.length),
  );
}

it("lets Super Admin open public-profile editing for every account, including their own", async () => {
  users = [
    user("employee"),
    user("admin", "ADMIN", false),
    user("current-super-admin", "SUPER_ADMIN", false),
    { ...user("inactive"), status: "INACTIVE" },
  ];
  await render();
  expect(
    container.querySelector('[aria-label="Edit public profile"]'),
  ).toBeNull();
  await render(true);
  expect(
    [
      ...container.querySelectorAll<HTMLAnchorElement>(
        '[aria-label="Edit public profile"]',
      ),
    ].map((link) => link.getAttribute("href")),
  ).toEqual(users.map((user) => `/admin/users/${user.id}/profile`));
});
async function edit(index = 0) {
  await act(async () => buttons("Edit user")[index].click());
}
async function submit() {
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

it("shows all four roles in All Users and does not offer administrator creation", async () => {
  users = [
    user("employee"),
    user("driver-manager", "MANAGE_DRIVER"),
    user("admin", "ADMIN", false),
    user("super-admin", "SUPER_ADMIN", false),
  ];
  await render();

  expect(container.querySelector("h1")?.textContent).toBe("All Users");
  expect(
    container.querySelector('input[aria-label="Search all users"]'),
  ).not.toBeNull();
  for (const row of users) expect(container.textContent).toContain(row.email);
  expect(buttons("Delete user")).toHaveLength(4);
  expect(
    [...container.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Add user"),
    ),
  ).toBe(false);
});

it("links active accounts to their public profile regardless of role or employee profile", async () => {
  users = [
    user("employee"),
    user("driver-manager", "MANAGE_DRIVER"),
    user("admin", "ADMIN", false),
    user("super-admin", "SUPER_ADMIN", false),
    { ...user("inactive"), status: "INACTIVE" },
    { ...user("suspended"), status: "SUSPENDED" },
  ];
  await render();

  const links = [
    ...container.querySelectorAll<HTMLAnchorElement>(
      'a[aria-label="View public profile (opens in new tab)"]',
    ),
  ];
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "/profile/employee",
    "/profile/driver-manager",
    "/profile/admin",
    "/profile/super-admin",
  ]);
  expect(writes).toHaveLength(0);
});

it("changes an employee's role and displays the authoritative refreshed role", async () => {
  await render();
  await edit();
  const role = container.querySelector<HTMLSelectElement>(
    'select[name="role"]',
  )!;
  expect([...role.options].map((option) => option.value)).toEqual([
    "EMPLOYEE",
    "MANAGE_DRIVER",
    "ADMIN",
    "SUPER_ADMIN",
  ]);
  expect([...role.options].every((option) => !option.disabled)).toBe(true);
  role.value = "MANAGE_DRIVER";
  await submit();

  await eventually(() => {
    expect(writes).toHaveLength(1);
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("tbody")?.textContent).toContain(
      "manage driver",
    );
  });
  expect(writes[0].method).toBe("PATCH");
  expect(new URL(writes[0].url).pathname).toBe("/api/admin/users/employee");
  expect(await writes[0].clone().json()).toMatchObject({
    role: "MANAGE_DRIVER",
  });
});

it("explains and disables employee roles for accounts without an employee profile", async () => {
  users = [user("admin", "ADMIN", false)];
  await render();
  await edit();

  const role = container.querySelector<HTMLSelectElement>(
    'select[name="role"]',
  )!;
  expect(
    [...role.options]
      .filter((option) => option.disabled)
      .map((option) => option.value),
  ).toEqual(["EMPLOYEE", "MANAGE_DRIVER"]);
  expect(container.textContent).toContain(
    "Employee and Manage Driver roles require an employee profile. This account does not have one.",
  );
  expect(writes).toHaveLength(0);
});

it("protects the current super administrator's access while allowing name edits", async () => {
  users = [user("current-super-admin", "SUPER_ADMIN", false)];
  await render();
  expect(buttons("Delete user")).toHaveLength(0);
  await edit();
  expect(container.querySelector('[name="role"]')).toBeNull();
  expect(container.querySelector('[name="status"]')).toBeNull();
  expect(container.textContent).toContain(
    "Your own role and account status cannot be changed here.",
  );
  container.querySelector<HTMLInputElement>('input[name="name"]')!.value =
    "Updated name";
  await submit();

  await eventually(() => expect(writes).toHaveLength(1));
  expect(await writes[0].clone().json()).toEqual({ name: "Updated name" });
});

it("explains permanent deletion and preserves the user when confirmation is cancelled", async () => {
  vi.mocked(confirmAction).mockResolvedValue(false);
  await render();
  await act(async () => buttons("Delete user")[0].click());

  expect(confirmAction).toHaveBeenCalledWith({
    title: "Delete user?",
    text: "Permanently delete this user account? This cannot be undone. Related records will be kept with the user’s details replaced by “deleted info”.",
    confirmText: "Delete user",
    danger: true,
  });
  expect(writes).toHaveLength(0);
  expect(container.textContent).toContain("employee@example.test");
});

it("sends one permanent deletion while pending and removes the user after refresh", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  mutation = async () => {
    await pending;
    users = [];
    return Response.json({ success: true, data: { id: "employee" } });
  };
  await render();
  await act(async () => {
    buttons("Delete user")[0].click();
    buttons("Delete user")[0].click();
  });
  await eventually(() => {
    expect(writes).toHaveLength(1);
    expect(buttons("Delete user")[0].disabled).toBe(true);
  });
  expect(writes[0].method).toBe("DELETE");
  expect(new URL(writes[0].url).pathname).toBe("/api/admin/users/employee");
  await act(async () => finish());
  await eventually(() => {
    expect(container.textContent).toContain(
      "User account permanently deleted.",
    );
    expect(container.textContent).not.toContain("employee@example.test");
    expect(buttons("Delete user")).toHaveLength(0);
  });
});

it("keeps a user and the server explanation visible when a concurrent change prevents deletion", async () => {
  const message =
    "This user changed while deletion was in progress. Please refresh and try again.";
  mutation = async () =>
    Response.json(
      { success: false, error: { code: "CONFLICT", message } },
      { status: 409 },
    );
  await render();
  await act(async () => buttons("Delete user")[0].click());

  await eventually(() => {
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      message,
    );
    expect(container.textContent).toContain("employee@example.test");
    expect(buttons("Delete user")[0].disabled).toBe(false);
  });
});

it("blocks further changes after a lost deletion response until a successful refresh", async () => {
  mutation = async () => {
    users = [];
    rejectReads = true;
    throw new TypeError("Network interrupted");
  };
  await render();
  await act(async () => buttons("Delete user")[0].click());
  await eventually(() => {
    expect(writes).toHaveLength(1);
    expect(buttons("Delete user")[0].disabled).toBe(true);
    expect(buttons("Edit user")[0].disabled).toBe(true);
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
  await eventually(() => expect(buttons("Delete user")).toHaveLength(0));
  expect(writes).toHaveLength(1);
});
