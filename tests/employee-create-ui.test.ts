// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "./i18n-root";
import { Provider } from "react-redux";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminResource } from "@/components/resource-workspace";
import {
  makeStore,
  clearWorkspaceData,
  type AppStore,
} from "@/store/make-store";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/client/alerts", () => ({
  confirmAction: vi.fn(),
  promptAction: vi.fn(),
  enqueueNotification: vi.fn(() => () => {}),
}));

const NativeRequest = globalThis.Request;
const password = "a strong employee password";
const employee = {
  id: "employee",
  employeeCode: "EMP-001",
  officeId: "office",
  office: { name: "Office" },
  departmentId: null,
  user: {
    id: "user",
    name: "Employee",
    email: "employee@example.test",
    role: "EMPLOYEE",
    status: "ACTIVE",
  },
};
let root: Root;
let container: HTMLDivElement;
let store: AppStore;
let writes: Request[];
let rejectReads: boolean;
let mutation: (request: Request) => Promise<Response>;

beforeEach(() => {
  writes = [];
  rejectReads = false;
  mutation = async () =>
    Response.json({ success: true, data: { id: "created-employee" } });
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
      const rows = path.endsWith("lookups/offices")
        ? [{ id: "office", name: "Office" }]
        : path.endsWith("lookups/departments")
          ? []
          : [employee];
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

function button(text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === text,
  );
}
function input(name: string) {
  return container.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
}
function passwordOption() {
  return container.querySelector<HTMLInputElement>(
    "#employee-password-enabled",
  )!;
}
async function eventually(assertion: () => void) {
  await act(async () => {
    await vi.waitFor(assertion);
  });
}
async function render(
  canCreateEmployees?: boolean,
  canEditPublicProfiles?: boolean,
) {
  await act(async () => {
    root.render(
      h(Provider, {
        store,
        children: h(AdminResource, {
          resource: "employees",
          canCreateEmployees,
          canEditPublicProfiles,
        }),
      }),
    );
  });
  await eventually(() =>
    expect(container.textContent).toContain(employee.user.email),
  );
}
async function openCreation(withPassword = false) {
  await render(true);
  await act(async () => button("Add employee")!.click());
  await eventually(() =>
    expect(input("officeId").querySelector('[value="office"]')).not.toBeNull(),
  );
  input("name").value = "New employee";
  input("email").value = "new.employee@example.test";
  input("employeeCode").value = "EMP-002";
  await act(async () => {
    input("officeId").value = "office";
    input("officeId").dispatchEvent(new Event("change", { bubbles: true }));
  });
  if (withPassword) {
    await act(async () => passwordOption().click());
    input("password").value = password;
    input("confirmPassword").value = password;
  }
}
async function submit() {
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

it.each([undefined, false])(
  "allows existing employee editing but hides creation without permission (%s)",
  async (permission) => {
    await render(permission);
    expect(button("Add employee")).toBeUndefined();
    expect(
      container.querySelector('[aria-label="Edit employee"]'),
    ).not.toBeNull();
    expect(writes).toHaveLength(0);
  },
);

it("creates a Google sign-in employee without requiring or sending a password", async () => {
  await openCreation();
  expect(passwordOption().checked).toBe(false);
  expect(input("password")).toBeNull();
  expect(input("confirmPassword")).toBeNull();
  expect(container.textContent).toContain("No application password is needed.");
  await submit();
  await eventually(() => expect(writes).toHaveLength(1));
  expect(await writes[0].clone().json()).toEqual({
    name: "New employee",
    email: "new.employee@example.test",
    employeeCode: "EMP-002",
    officeId: "office",
    departmentId: null,
    role: "EMPLOYEE",
    status: "ACTIVE",
  });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it.each(["ADMIN", "SUPER_ADMIN"])(
  "creates a %s account with an employee profile and optional password",
  async (role) => {
    await openCreation();
    const roles = container.querySelector<HTMLSelectElement>('[name="role"]')!;
    expect([...roles.options].map((option) => option.value)).toEqual([
      "EMPLOYEE",
      "MANAGE_DRIVER",
      "ADMIN",
      "SUPER_ADMIN",
    ]);
    expect(container.textContent).toContain(
      "Every role receives an employee profile.",
    );
    roles.value = role;
    await submit();
    await eventually(() => expect(writes).toHaveLength(1));
    expect(await writes[0].clone().json()).toEqual({
      name: "New employee",
      email: "new.employee@example.test",
      employeeCode: "EMP-002",
      officeId: "office",
      departmentId: null,
      role,
      status: "ACTIVE",
    });
  },
);

it("asks for a masked application password only when optional password sign-in is selected", async () => {
  await openCreation(true);
  for (const name of ["password", "confirmPassword"]) {
    expect(input(name).type).toBe("password");
    expect(input(name).autocomplete).toBe("new-password");
    expect(input(name).required).toBe(true);
    expect(input(name).minLength).toBe(12);
    expect(input(name).maxLength).toBe(128);
  }
  const toggle = container.querySelector<HTMLButtonElement>(
    '[aria-label="Show application password *"]',
  )!;
  await act(async () => toggle.click());
  expect(input("password").type).toBe("text");
  await act(async () => button("Cancel")!.click());
  await act(async () => button("Add employee")!.click());
  expect(passwordOption().checked).toBe(false);
  expect(input("password")).toBeNull();
  expect(input("confirmPassword")).toBeNull();
  await act(async () => passwordOption().click());
  expect(input("password").value).toBe("");
  expect(input("confirmPassword").value).toBe("");
});

it("clears credentials when switching back to Google sign-in and omits them from creation", async () => {
  await openCreation(true);
  input("confirmPassword").value = "does not match";
  await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "The passwords do not match.",
  );
  await act(async () => passwordOption().click());
  expect(input("password")).toBeNull();
  expect(input("confirmPassword")).toBeNull();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => passwordOption().click());
  expect(input("password").value).toBe("");
  expect(input("confirmPassword").value).toBe("");
  await act(async () => passwordOption().click());
  await submit();
  expect(writes).toHaveLength(1);
  const payload = await writes[0].clone().json();
  expect(payload).not.toHaveProperty("password");
  expect(payload).not.toHaveProperty("confirmPassword");
  expect(JSON.stringify(store.getState())).not.toContain(password);
});

it.each([
  ["", "", "Use a password between 12 and 128 characters."],
  ["short", "short", "Use a password between 12 and 128 characters."],
  [
    "a".repeat(129),
    "a".repeat(129),
    "Use a password between 12 and 128 characters.",
  ],
  [password, "another strong password", "The passwords do not match."],
])(
  "rejects invalid creation passwords before sending (%s)",
  async (value, confirmation, message) => {
    await openCreation(true);
    input("password").value = value;
    input("confirmPassword").value = confirmation;
    await submit();
    expect(writes).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      message,
    );
  },
);

it("creates the account directly without putting credentials in Redux", async () => {
  await openCreation(true);
  const dispatch = vi.spyOn(store, "dispatch");
  await submit();
  await eventually(() => expect(writes).toHaveLength(1));
  expect(writes[0].method).toBe("POST");
  expect(new URL(writes[0].url).pathname).toBe("/api/admin/employees");
  expect(await writes[0].clone().json()).toEqual({
    name: "New employee",
    email: "new.employee@example.test",
    password,
    confirmPassword: password,
    employeeCode: "EMP-002",
    officeId: "office",
    departmentId: null,
    role: "EMPLOYEE",
    status: "ACTIVE",
  });
  expect(JSON.stringify(store.getState())).not.toContain(password);
  expect(JSON.stringify(dispatch.mock.calls)).not.toContain(password);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it("blocks creation if permission changes while its form is open", async () => {
  await openCreation();
  await render(false);
  await submit();
  expect(writes).toHaveLength(0);
});

it.each([false, true])(
  "sends only one request while account creation is pending (password: %s)",
  async (withPassword) => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mutation = async () => {
      await pending;
      return Response.json({ success: true, data: { id: "created-employee" } });
    };
    await openCreation(withPassword);
    await submit();
    await submit();
    expect(writes).toHaveLength(1);
    expect(button("Save changes")).toBeUndefined();
    expect(button("Saving…")!.disabled).toBe(true);
    expect(passwordOption().disabled).toBe(true);
    if (withPassword) expect(input("password").disabled).toBe(true);
    await act(async () => finish());
    await eventually(() =>
      expect(container.querySelector('[role="dialog"]')).toBeNull(),
    );
  },
);

it("prevents replay after an uncertain creation until records refresh successfully", async () => {
  mutation = async () => {
    rejectReads = true;
    throw new TypeError("Network interrupted");
  };
  await openCreation(true);
  await submit();
  await eventually(() =>
    expect(container.textContent).toContain("The result is uncertain."),
  );
  expect(input("password").value).toBe("");
  expect(input("confirmPassword").value).toBe("");
  expect(button("Save changes")!.disabled).toBe(true);
  await submit();
  expect(writes).toHaveLength(1);
  rejectReads = false;
  await act(async () => button("Refresh records")!.click());
  await eventually(() => expect(button("Save changes")!.disabled).toBe(false));
  expect(writes).toHaveLength(1);
});

it("clears credentials after a rejected write so they are not retained in the form", async () => {
  mutation = async () =>
    Response.json(
      {
        success: false,
        error: { code: "CONFLICT", message: "Email is already in use." },
      },
      { status: 409 },
    );
  await openCreation(true);
  await submit();
  await eventually(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Email is already in use.",
    ),
  );
  expect(input("password").value).toBe("");
  expect(input("confirmPassword").value).toBe("");
  expect(JSON.stringify(store.getState())).not.toContain(password);
});

it("keeps normal employee edits available without asking for or submitting credentials", async () => {
  await render(false);
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Edit employee"]')!
      .click(),
  );
  expect(input("password")).toBeNull();
  expect(input("confirmPassword")).toBeNull();
  expect(passwordOption()).toBeNull();
  await submit();
  await eventually(() => expect(writes).toHaveLength(1));
  expect(writes[0].method).toBe("PATCH");
  const payload = await writes[0].clone().json();
  expect(payload).not.toHaveProperty("password");
  expect(payload).not.toHaveProperty("confirmPassword");
  expect(payload).not.toHaveProperty("name");
  expect(input("name")).toBeNull();
});

it("only links to the public-profile editor when explicitly permitted", async () => {
  await render(true);
  expect(
    container.querySelector('[aria-label="Edit public profile"]'),
  ).toBeNull();
  await render(true, true);
  expect(
    container
      .querySelector('[aria-label="Edit public profile"]')
      ?.getAttribute("href"),
  ).toBe("/admin/users/user/profile");
  await render(true, false);
  expect(
    container.querySelector('[aria-label="Edit public profile"]'),
  ).toBeNull();
});

it("keeps the employee name editable for Super Admin", async () => {
  await render(true, true);
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Edit employee"]')!
      .click(),
  );
  expect(input("name").value).toBe(employee.user.name);
  input("name").value = "Updated name";
  await submit();
  expect(await writes[0].clone().json()).toHaveProperty("name", "Updated name");
});
