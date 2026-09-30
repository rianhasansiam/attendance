// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "./i18n-root";
import { Provider } from "react-redux";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminResource } from "@/components/resource-workspace";
import { confirmAction } from "@/lib/client/alerts";
import {
  makeStore,
  clearWorkspaceData,
  type AppStore,
} from "@/store/make-store";
import { managementApi } from "@/store/features/management/api";

const { refreshRouter } = vi.hoisted(() => ({ refreshRouter: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ refresh: refreshRouter }),
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
let records: ReturnType<typeof record>[];
let rejectReads: boolean;
let rejectAccountReads: boolean;
let offPageAccount: { id: string; employee: { id: string } } | undefined;
let mutation: (request: Request) => Promise<Response>;

function record(role: string, hasEmployeeProfile: boolean, status = "ACTIVE") {
  const userId = `${role.toLowerCase()}-${hasEmployeeProfile ? "employee" : "user"}`;
  return {
    id: hasEmployeeProfile ? `employee-${userId}` : `user:${userId}`,
    userId,
    hasEmployeeProfile,
    employeeCode: hasEmployeeProfile ? `EMP-${userId}` : null,
    officeId: hasEmployeeProfile ? "office" : null,
    departmentId: null,
    office: hasEmployeeProfile ? { name: "Office" } : null,
    department: null,
    user: {
      id: userId,
      name: userId,
      email: `${userId}@example.test`,
      role,
      status,
    },
  };
}

beforeEach(() => {
  refreshRouter.mockReset();
  writes = [];
  rejectReads = false;
  rejectAccountReads = false;
  offPageAccount = undefined;
  vi.mocked(confirmAction).mockReset().mockResolvedValue(true);
  mutation = async (request) => {
    const path = new URL(request.url).pathname;
    const addingProfile = path.endsWith("/employee-profile");
    const id = path.split("/").at(addingProfile ? -2 : -1)!;
    if (addingProfile) {
      const body = await request.clone().json();
      records = records.map((row) =>
        row.user.id === id
          ? {
              ...row,
              ...body,
              id: `employee-${id}`,
              hasEmployeeProfile: true,
              office: { name: "Office" },
            }
          : row,
      );
    } else if (request.method === "DELETE") {
      records = records.filter((row) => row.user.id !== id);
    } else {
      const body = await request.clone().json();
      records = records.map((row) =>
        row.user.id === id ? { ...row, user: { ...row.user, ...body } } : row,
      );
    }
    return Response.json({ success: true, data: { id } });
  };
  records = [
    record("EMPLOYEE", true),
    record("MANAGE_DRIVER", true),
    record("ADMIN", true),
    record("SUPER_ADMIN", true),
    record("ADMIN", false),
    record("SUPER_ADMIN", false),
    record("EMPLOYEE", false),
    record("MANAGE_DRIVER", false),
  ];
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
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method !== "GET") {
        writes.push(request);
        return mutation(request);
      }
      if (rejectReads)
        return Response.json({ success: false }, { status: 503 });
      const path = new URL(request.url).pathname;
      if (path.startsWith("/api/admin/users/")) {
        if (rejectAccountReads)
          return Response.json({ success: false }, { status: 503 });
        const id = path.split("/").at(-1);
        const row = records.find((entry) => entry.user.id === id);
        return Response.json({
          success: true,
          data:
            offPageAccount?.id === id
              ? offPageAccount
              : row && {
                  ...row.user,
                  employee: row.hasEmployeeProfile ? { id: row.id } : null,
                },
        });
      }
      const rows = path.endsWith("lookups/offices")
        ? [{ id: "office", name: "Office" }]
        : path.endsWith("lookups/departments")
          ? []
          : records;
      return Response.json({
        success: true,
        data: { items: rows, total: rows.length, page: 1, pageSize: 25 },
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

async function render(superAdmin: boolean, currentUserId?: string) {
  await act(async () => {
    root.render(
      h(Provider, {
        store,
        children: h(AdminResource, {
          resource: "employees",
          canCreateEmployees: superAdmin,
          canDeleteEmployees: superAdmin,
          canEditPublicProfiles: superAdmin,
          canManageUsers: superAdmin,
          currentUserId,
        }),
      }),
    );
  });
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.querySelectorAll("tbody tr")).toHaveLength(
        records.length,
      ),
    );
  });
}

function rowFor(entry: ReturnType<typeof record>) {
  return [...container.querySelectorAll("tbody tr")].find((row) =>
    row.textContent?.includes(entry.user.email),
  )!;
}

it.each([false, true])(
  "shows every account with valid role-specific actions (super admin: %s)",
  async (superAdmin) => {
    await render(superAdmin);
    expect(container.textContent).toContain(
      "Manage user accounts and employee details in one place.",
    );
    for (const record of records) {
      const row = rowFor(record);
      expect(row).toBeDefined();
      expect(row.querySelectorAll("td")[5].textContent).toBe(
        record.user.role.toLowerCase().replaceAll("_", " "),
      );
      const isAdministrator = ["ADMIN", "SUPER_ADMIN"].includes(
        record.user.role,
      );
      expect(
        row
          .querySelector(
            'a[aria-label="View public profile (opens in new tab)"]',
          )
          ?.getAttribute("href"),
      ).toBe(`/profile/${record.user.id}`);
      expect(
        row
          .querySelector('a[aria-label="View employee attendance"]')
          ?.getAttribute("href"),
      ).toBe(
        record.hasEmployeeProfile
          ? `/admin/attendance?employeeId=${record.id}`
          : undefined,
      );
      expect(
        row.querySelector('button[aria-label="Edit employee"]') !== null,
      ).toBe(record.hasEmployeeProfile && (superAdmin || !isAdministrator));
      expect(
        row.querySelector('button[aria-label="Delete user"]') !== null,
      ).toBe(superAdmin);
      expect(
        row.querySelector('button[aria-label="Delete employee"]'),
      ).toBeNull();
      expect(
        row
          .querySelector('a[aria-label="Edit public profile"]')
          ?.getAttribute("href"),
      ).toBe(superAdmin ? `/admin/users/${record.user.id}/profile` : undefined);
      expect(
        row.querySelector('button[aria-label="Manage account"]') !== null,
      ).toBe(superAdmin);
      expect(
        row.querySelector('button[aria-label="Add employee profile"]') !== null,
      ).toBe(superAdmin && !record.hasEmployeeProfile);
      if (!record.hasEmployeeProfile) {
        const cells = row.querySelectorAll("td");
        expect(cells[1].textContent).toBe("—");
        expect(cells[3].textContent).toBe("—");
        expect(cells[4].textContent).toBe("—");
      }
    }
    expect(writes).toHaveLength(0);
  },
);

it.each(["INACTIVE", "SUSPENDED"])(
  "hides public links for %s administrators while retaining super admin account management",
  async (status) => {
    records = [
      record("ADMIN", false, status),
      record("SUPER_ADMIN", false, status),
    ];
    await render(true);
    expect(
      container.querySelectorAll(
        'a[aria-label="View public profile (opens in new tab)"]',
      ),
    ).toHaveLength(0);
    expect(
      container.querySelectorAll('button[aria-label="Manage account"]'),
    ).toHaveLength(2);
    expect(
      container.querySelectorAll('a[aria-label="Edit public profile"]'),
    ).toHaveLength(2);
    expect(
      container.querySelectorAll('button[aria-label="Edit employee"]'),
    ).toHaveLength(0);
  },
);

it.each([false, true])(
  "retains employee editing when an administrator opens the directory (super admin: %s)",
  async (superAdmin) => {
    await render(superAdmin);
    const record = records[0];
    await act(async () => {
      rowFor(record)
        .querySelector<HTMLButtonElement>('button[aria-label="Edit employee"]')!
        .click();
    });
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(
      dialog.querySelector<HTMLInputElement>('[name="employeeCode"]')?.value,
    ).toBe(record.employeeCode);
    expect(
      dialog.querySelector<HTMLInputElement>('[name="email"]')?.value,
    ).toBe(record.user.email);
    expect(dialog.querySelector('[name="role"]')).not.toBeNull();
    expect(
      [
        ...dialog.querySelector<HTMLSelectElement>('[name="role"]')!.options,
      ].map((option) => option.value),
    ).toEqual(["EMPLOYEE", "MANAGE_DRIVER"]);
    expect(writes).toHaveLength(0);
  },
);

it("lets super admins edit real administrator employee profiles without offering employee-only roles", async () => {
  await render(true);
  await act(async () => {
    rowFor(records[2])
      .querySelector<HTMLButtonElement>('button[aria-label="Edit employee"]')!
      .click();
  });
  const dialog = container.querySelector('[role="dialog"]')!;
  expect(
    dialog.querySelector<HTMLInputElement>('[name="employeeCode"]')?.value,
  ).toBe(records[2].employeeCode);
  expect(dialog.querySelector('[name="role"]')).toBeNull();
});

async function eventually(assertion: () => void) {
  await act(async () => {
    await vi.waitFor(assertion);
  });
}

async function openAccount(entry: ReturnType<typeof record>) {
  await act(async () => {
    rowFor(entry)
      .querySelector<HTMLButtonElement>('button[aria-label="Manage account"]')!
      .click();
  });
}

async function submit() {
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

async function openEmployeeProfile(entry: ReturnType<typeof record>) {
  await act(async () =>
    rowFor(entry)
      .querySelector<HTMLButtonElement>('[aria-label="Add employee profile"]')!
      .click(),
  );
  await eventually(() =>
    expect(
      container.querySelector('[name="officeId"] [value="office"]'),
    ).not.toBeNull(),
  );
  container.querySelector<HTMLInputElement>('[name="employeeCode"]')!.value =
    "STAFF-001";
  await act(async () => {
    const office =
      container.querySelector<HTMLSelectElement>('[name="officeId"]')!;
    office.value = "office";
    office.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it.each(["EMPLOYEE", "MANAGE_DRIVER", "ADMIN", "SUPER_ADMIN"])(
  "attaches employee data to an existing %s account without changing its identity or sign-in settings",
  async (role) => {
    records = [record(role, false)];
    const entry = records[0];
    await render(true, role === "SUPER_ADMIN" ? entry.user.id : "actor");
    await openEmployeeProfile(entry);
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-label")).toBe("Add employee profile");
    expect(dialog.textContent).toContain(entry.user.name);
    expect(dialog.textContent).toContain(entry.user.email);
    expect(dialog.textContent).toContain(
      "sign-in methods, and role stay the same.",
    );
    expect(
      [...dialog.querySelectorAll("[name]")].map((field) =>
        field.getAttribute("name"),
      ),
    ).toEqual(["employeeCode", "officeId", "departmentId"]);
    await submit();
    await eventually(() => {
      expect(writes).toHaveLength(1);
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(
        rowFor(entry).querySelector('[aria-label="Add employee profile"]'),
      ).toBeNull();
      expect(
        rowFor(entry).querySelector('[aria-label="Edit employee"]'),
      ).not.toBeNull();
      expect(
        rowFor(entry)
          .querySelector('a[aria-label="View employee attendance"]')
          ?.getAttribute("href"),
      ).toBe(`/admin/attendance?employeeId=employee-${entry.user.id}`);
    });
    expect(writes[0].method).toBe("POST");
    expect(new URL(writes[0].url).pathname).toBe(
      `/api/admin/users/${entry.user.id}/employee-profile`,
    );
    expect(await writes[0].clone().json()).toEqual({
      employeeCode: "STAFF-001",
      officeId: "office",
      departmentId: null,
    });
    expect(records[0].user).toEqual(entry.user);
    expect(refreshRouter).toHaveBeenCalledTimes(role === "SUPER_ADMIN" ? 1 : 0);
  },
);

it("refreshes cached user lists and employee selectors after adding a profile", async () => {
  records = [record("ADMIN", false)];
  await act(async () => {
    await Promise.all([
      store
        .dispatch(
          managementApi.endpoints.getManagement.initiate({
            resource: "users",
            params: { page: 1, pageSize: 25 },
          }),
        )
        .unwrap(),
      store
        .dispatch(
          managementApi.endpoints.getReference.initiate({
            resource: "employees",
            params: { page: 1, pageSize: 100 },
          }),
        )
        .unwrap(),
    ]);
  });
  await render(true);
  await openEmployeeProfile(records[0]);
  await submit();
  await eventually(() => {
    const paths = vi
      .mocked(fetch)
      .mock.calls.map(
        ([input, init]) => new URL(new Request(input, init).url).pathname,
      );
    expect(paths.filter((path) => path === "/api/admin/users")).toHaveLength(2);
    expect(
      paths.filter((path) => path === "/api/admin/lookups/employees"),
    ).toHaveLength(2);
  });
});

it("submits an employee-profile attachment only once while the response is pending", async () => {
  records = [record("ADMIN", false)];
  let finish!: (response: Response) => void;
  mutation = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  await render(true);
  await openEmployeeProfile(records[0]);
  await submit();
  await submit();
  expect(writes).toHaveLength(1);
  expect(
    container.querySelector<HTMLButtonElement>('button[type="submit"]')
      ?.disabled,
  ).toBe(true);
  await act(async () =>
    finish(Response.json({ success: true, data: { id: "employee" } })),
  );
  await eventually(() =>
    expect(container.querySelector('[role="dialog"]')).toBeNull(),
  );
  expect(writes).toHaveLength(1);
});

it("reconciles a lost attachment response before allowing another change", async () => {
  records = [record("SUPER_ADMIN", false)];
  const entry = records[0];
  const attach = mutation;
  mutation = async (request) => {
    await attach(request);
    rejectReads = true;
    throw new TypeError("Response lost");
  };
  await render(true, entry.user.id);
  await openEmployeeProfile(entry);
  await submit();
  await eventually(() => {
    expect(container.textContent).toContain("The result is uncertain.");
    expect(
      container.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.disabled,
    ).toBe(true);
  });
  await submit();
  expect(writes).toHaveLength(1);
  expect(refreshRouter).not.toHaveBeenCalled();
  rejectReads = false;
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Refresh records")!
      .click(),
  );
  await eventually(() => {
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(
      rowFor(entry).querySelector('[aria-label="Add employee profile"]'),
    ).toBeNull();
  });
  expect(writes).toHaveLength(1);
  expect(refreshRouter).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "reconciles an attachment that moves off the current page, keeping writes blocked when the account read fails (close modal: %s)",
  async (closeModal) => {
    records = [record("SUPER_ADMIN", false), record("EMPLOYEE", true)];
    const entry = records[0];
    await act(async () => {
      await store
        .dispatch(
          managementApi.endpoints.getReference.initiate({
            resource: "employees",
            params: { page: 1, pageSize: 100 },
          }),
        )
        .unwrap();
    });
    const attach = mutation;
    mutation = async (request) => {
      await attach(request);
      offPageAccount = { id: entry.user.id, employee: { id: records[0].id } };
      records = records.slice(1);
      rejectAccountReads = true;
      throw new TypeError("Response lost");
    };
    await render(true, entry.user.id);
    await openEmployeeProfile(entry);
    await submit();
    await eventually(() => {
      expect(rowFor(entry)).toBeUndefined();
      expect(container.textContent).toContain("The result is uncertain.");
      expect(
        container.querySelector<HTMLButtonElement>('button[type="submit"]')
          ?.disabled,
      ).toBe(true);
    });
    await submit();
    expect(writes).toHaveLength(1);
    expect(refreshRouter).not.toHaveBeenCalled();
    if (closeModal) {
      await act(async () =>
        [...container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent === "Cancel")!
          .click(),
      );
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(
        container.querySelector<HTMLButtonElement>(
          '[aria-label="Manage account"]',
        )?.disabled,
      ).toBe(true);
    }
    rejectAccountReads = false;
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find(
          (button) =>
            button.textContent?.trim() ===
            (closeModal ? "Refresh" : "Refresh records"),
        )!
        .click(),
    );
    await eventually(() => {
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(container.textContent).toContain("Your changes have been saved.");
      expect(refreshRouter).toHaveBeenCalledTimes(1);
      expect(
        container.querySelector<HTMLButtonElement>(
          '[aria-label="Manage account"]',
        )?.disabled,
      ).toBe(false);
      const paths = vi
        .mocked(fetch)
        .mock.calls.map(
          ([input, init]) => new URL(new Request(input, init).url).pathname,
        );
      expect(
        paths.filter((path) => path === "/api/admin/lookups/employees"),
      ).toHaveLength(2);
      expect(
        paths.filter((path) => path === `/api/admin/users/${entry.user.id}`),
      ).toHaveLength(2);
    });
    expect(writes).toHaveLength(1);
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Refresh")!
        .click(),
    );
    await eventually(() =>
      expect(
        container.querySelector<HTMLButtonElement>(
          '[aria-label="Manage account"]',
        )?.disabled,
      ).toBe(false),
    );
    const paths = vi
      .mocked(fetch)
      .mock.calls.map(
        ([input, init]) => new URL(new Request(input, init).url).pathname,
      );
    expect(
      paths.filter((path) => path.startsWith("/api/admin/users/")),
    ).toEqual([
      `/api/admin/users/${entry.user.id}/employee-profile`,
      `/api/admin/users/${entry.user.id}`,
      `/api/admin/users/${entry.user.id}`,
    ]);
  },
);

it("manages an account inline with the user endpoint and refreshes its employee row", async () => {
  await render(true);
  const entry = records[0];
  await openAccount(entry);
  const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain(entry.user.email);
  expect(dialog.querySelector('[name="email"]')).toBeNull();
  expect(dialog.querySelector('[name="employeeCode"]')).toBeNull();
  const role = dialog.querySelector<HTMLSelectElement>('[name="role"]')!;
  expect([...role.options].map((option) => option.value)).toEqual([
    "EMPLOYEE",
    "MANAGE_DRIVER",
    "ADMIN",
    "SUPER_ADMIN",
  ]);
  expect([...role.options].some((option) => option.disabled)).toBe(false);
  role.value = "ADMIN";
  dialog.querySelector<HTMLSelectElement>('[name="status"]')!.value =
    "INACTIVE";
  await submit();
  await eventually(() => {
    expect(writes).toHaveLength(1);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(rowFor(entry).textContent).toContain("inactive");
    expect(
      rowFor(entry).querySelector(
        '[aria-label="View public profile (opens in new tab)"]',
      ),
    ).toBeNull();
  });
  expect(writes[0].method).toBe("PATCH");
  expect(new URL(writes[0].url).pathname).toBe(
    `/api/admin/users/${entry.user.id}`,
  );
  expect(await writes[0].clone().json()).toEqual({
    name: entry.user.name,
    role: "ADMIN",
    status: "INACTIVE",
  });
});

it.each(["EMPLOYEE", "MANAGE_DRIVER", "ADMIN", "SUPER_ADMIN"])(
  "disables employee roles for a %s account without employee data",
  async (role) => {
    records = [record(role, false)];
    await render(true);
    await openAccount(records[0]);
    const select = container.querySelector<HTMLSelectElement>('[name="role"]')!;
    expect(
      [...select.options]
        .filter((option) => option.disabled)
        .map((option) => option.value),
    ).toEqual(["EMPLOYEE", "MANAGE_DRIVER"]);
    expect(container.textContent).toContain("This account does not have one.");
    expect(writes).toHaveLength(0);
  },
);

it.each([false, true])(
  "protects the current account with an employee profile: %s",
  async (hasProfile) => {
    records = [record("SUPER_ADMIN", hasProfile)];
    const entry = records[0];
    await render(true, entry.user.id);
    expect(
      rowFor(entry).querySelector('[aria-label="Delete user"]'),
    ).toBeNull();
    await openAccount(entry);
    expect(container.querySelector('[name="role"]')).toBeNull();
    expect(container.querySelector('[name="status"]')).toBeNull();
    container.querySelector<HTMLInputElement>('[name="name"]')!.value =
      "My updated name";
    await submit();
    await eventually(() => expect(writes).toHaveLength(1));
    expect(await writes[0].clone().json()).toEqual({ name: "My updated name" });
    if (hasProfile) {
      await eventually(() =>
        expect(container.querySelector('[role="dialog"]')).toBeNull(),
      );
      await act(async () =>
        rowFor(entry)
          .querySelector<HTMLButtonElement>('[aria-label="Edit employee"]')!
          .click(),
      );
      expect(container.querySelector('[name="role"]')).toBeNull();
      expect(container.querySelector('[name="status"]')).toBeNull();
    }
  },
);

it.each(["EMPLOYEE", "MANAGE_DRIVER"])(
  "updates a %s account without resubmitting its unavailable employee role",
  async (role) => {
    records = [record(role, false)];
    await render(true);
    await openAccount(records[0]);
    container.querySelector<HTMLInputElement>('[name="name"]')!.value =
      "Updated account";
    container.querySelector<HTMLSelectElement>('[name="status"]')!.value =
      "SUSPENDED";
    await submit();
    await eventually(() => expect(writes).toHaveLength(1));
    expect(await writes[0].clone().json()).toEqual({
      name: "Updated account",
      status: "SUSPENDED",
    });
  },
);

it("retains employee editing after managing an account", async () => {
  await render(true);
  const entry = records[0];
  await openAccount(entry);
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Cancel")!
      .click();
  });
  await act(async () =>
    rowFor(entry)
      .querySelector<HTMLButtonElement>('[aria-label="Edit employee"]')!
      .click(),
  );
  expect(
    container.querySelector<HTMLInputElement>('[name="employeeCode"]')?.value,
  ).toBe(entry.employeeCode);
  await submit();
  await eventually(() => expect(writes).toHaveLength(1));
  expect(new URL(writes[0].url).pathname).toBe(
    `/api/admin/employees/${entry.id}`,
  );
  expect(await writes[0].clone().json()).toMatchObject({
    employeeCode: entry.employeeCode,
    officeId: entry.officeId,
  });
});

it("confirms account deletion once and sends the user ID instead of the employee ID", async () => {
  let confirm!: (value: boolean) => void;
  vi.mocked(confirmAction).mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        confirm = resolve;
      }),
  );
  await render(true);
  const entry = records[0];
  const remove = rowFor(entry).querySelector<HTMLButtonElement>(
    '[aria-label="Delete user"]',
  )!;
  await act(async () => {
    remove.click();
    remove.click();
  });
  expect(confirmAction).toHaveBeenCalledTimes(1);
  expect(confirmAction).toHaveBeenCalledWith({
    title: "Delete user?",
    text: "Permanently delete this user account? This cannot be undone. Related records will be kept with the user’s details replaced by “deleted info”.",
    confirmText: "Delete user",
    danger: true,
  });
  expect(writes).toHaveLength(0);
  await act(async () => confirm(true));
  await eventually(() => {
    expect(writes).toHaveLength(1);
    expect(container.textContent).not.toContain(entry.user.email);
    expect(container.textContent).toContain(
      "User account permanently deleted.",
    );
  });
  expect(writes[0].method).toBe("DELETE");
  expect(new URL(writes[0].url).pathname).toBe(
    `/api/admin/users/${entry.user.id}`,
  );
});

it.each([false, true])(
  "removes a confirmed deletion from stale directory data with an employee profile: %s",
  async (hasProfile) => {
    records = [record("ADMIN", hasProfile), record("EMPLOYEE", true)];
    const entry = records[0];
    mutation = async () => {
      records = records.slice(1);
      rejectReads = true;
      return Response.json({ success: true, data: { id: entry.user.id } });
    };
    await render(true);
    await act(async () =>
      rowFor(entry)
        .querySelector<HTMLButtonElement>('[aria-label="Delete user"]')!
        .click(),
    );
    await eventually(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Refresh failed.",
      );
      expect(container.textContent).not.toContain(entry.user.email);
      expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
      expect(
        container.querySelector('.toolbar [role="status"]')?.textContent,
      ).toBe("1 record");
    });
    expect(writes).toHaveLength(1);
  },
);

it("blocks account and employee mutations after a lost response until the directory refreshes", async () => {
  const entry = records[0];
  mutation = async () => {
    records = records.slice(1);
    rejectReads = true;
    throw new TypeError("Network interrupted");
  };
  await render(true);
  await act(async () =>
    rowFor(entry)
      .querySelector<HTMLButtonElement>('[aria-label="Delete user"]')!
      .click(),
  );
  await eventually(() => {
    expect(writes).toHaveLength(1);
    expect(
      rowFor(entry).querySelector<HTMLButtonElement>(
        '[aria-label="Manage account"]',
      )?.disabled,
    ).toBe(true);
    expect(
      rowFor(entry).querySelector<HTMLButtonElement>(
        '[aria-label="Edit employee"]',
      )?.disabled,
    ).toBe(true);
    expect(
      rowFor(entry).querySelector<HTMLButtonElement>(
        '[aria-label="Delete user"]',
      )?.disabled,
    ).toBe(true);
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
    expect(container.textContent).not.toContain(entry.user.email);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Manage account"]',
      )?.disabled,
    ).toBe(false);
  });
  expect(writes).toHaveLength(1);
});
