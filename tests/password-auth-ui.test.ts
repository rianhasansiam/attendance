// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider } from "react-redux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialsForm } from "@/components/auth/credentials-form";
import { AccountPasswordForm } from "@/components/auth/account-password-form";
import { AppShell } from "@/components/app-shell";
import {
  clearWorkspaceData,
  makeStore,
  type AppStore,
} from "@/store/make-store";

const auth = vi.hoisted(() => ({ signIn: vi.fn(), signOut: vi.fn() }));
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next-auth/react", () => auth);
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => window.location.pathname,
}));

let root: Root;
let container: HTMLDivElement;
let store: AppStore;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const password = "  a sufficiently long passphrase  ";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/login");
  auth.signIn.mockResolvedValue({ ok: true, url: "/", status: 200 });
  auth.signOut.mockResolvedValue(undefined);
  fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json({ success: true, data: { message: "Done." } }),
    );
  vi.stubGlobal("fetch", fetchMock);
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

async function render(children: React.ReactNode) {
  await act(async () => root.render(h(Provider, { store, children })));
}
function input(name: string) {
  return container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
}
async function fill(name: string, value: string) {
  await act(async () => {
    const element = input(name);
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
function requestBody(call = 0) {
  return JSON.parse(String(fetchMock.mock.calls[call][1]?.body));
}
function alertText() {
  return container.querySelector('[role="alert"]')?.textContent;
}
async function newPasswords(value = password, confirm = value) {
  await fill("newPassword", value);
  await fill("confirmPassword", confirm);
}

describe("credentials sign-in", () => {
  it("uses the supported Auth.js flow, normalizes email, preserves the password and redirects through the existing role router", async () => {
    await render(h(CredentialsForm));
    await fill("email", " PERSON@Example.test ");
    await fill("password", password);
    await submit();
    expect(auth.signIn).toHaveBeenCalledExactlyOnceWith("credentials", {
      email: "person@example.test",
      password,
      redirect: false,
      redirectTo: "/",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith("/");
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(input("password").value).toBe("");
  });

  it.each(["invalid_password", "unknown_email", "no_password", "inactive"])(
    "hides the provider's %s reason and clears the submitted password",
    async (code) => {
      auth.signIn.mockResolvedValue({
        ok: true,
        error: "CredentialsSignin",
        code,
      });
      await render(h(CredentialsForm));
      await fill("email", "person@example.test");
      await fill("password", password);
      await submit();
      expect(alertText()).toBe("Invalid email or password.");
      expect(container.textContent).not.toContain(code);
      expect(router.replace).not.toHaveBeenCalled();
      expect(input("password").value).toBe("");
    },
  );

  it("disables the inputs and prevents duplicate submissions while sign-in is pending", async () => {
    let release!: (value: unknown) => void;
    auth.signIn.mockReturnValue(new Promise((resolve) => (release = resolve)));
    await render(h(CredentialsForm));
    await fill("email", "person@example.test");
    await fill("password", password);
    await submit();
    await submit();
    expect(auth.signIn).toHaveBeenCalledOnce();
    expect(input("email").disabled).toBe(true);
    expect(input("password").disabled).toBe(true);
    expect(container.querySelector("form")!.getAttribute("aria-busy")).toBe(
      "true",
    );
    await act(async () => release({ error: "CredentialsSignin", ok: false }));
    expect(input("email").disabled).toBe(false);
  });

  it("offers accessible password visibility and uses an application-password explanation", async () => {
    await render(h(CredentialsForm));
    const element = input("password");
    expect(element.type).toBe("password");
    expect(element.autocomplete).toBe("current-password");
    expect(
      container.querySelector(`label[for="${element.id}"]`)?.textContent,
    ).toBe("Application password");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Show application password"]',
        )!
        .click(),
    );
    expect(element.type).toBe("text");
    expect(container.querySelector('[aria-pressed="true"]')).not.toBeNull();
    expect(container.textContent).toContain("never your Google password");
    expect(container.querySelector('a[href="/forgot-password"]')).toBeNull();
  });

  it("rejects an overlong password without truncating it or sending a request", async () => {
    await render(h(CredentialsForm));
    await fill("email", "person@example.test");
    await fill("password", "a".repeat(129));
    await submit();
    expect(auth.signIn).not.toHaveBeenCalled();
    expect(input("password").value).toHaveLength(129);
    expect(input("password").hasAttribute("maxlength")).toBe(false);
    expect(alertText()).toBe("Invalid email or password.");
  });
});

describe("account password settings", () => {
  it("offers Google-only users set-password and submits no client account identity", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ success: true, data: { hasPassword: false } }),
    );
    await render(h(AccountPasswordForm));
    expect(container.querySelector("h2")?.textContent).toBe("Set password");
    expect(input("currentPassword")).toBeNull();
    await newPasswords();
    await submit();
    expect(requestBody(1)).toEqual({
      newPassword: password,
      confirmPassword: password,
    });
    expect(auth.signOut).toHaveBeenCalledExactlyOnceWith({
      redirectTo: "/login",
    });
    expect(store.getState().workspaceUi.status).toBe("signed-out");
  });

  it("requires and submits the current password for an existing password and preserves the session on verification failure", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ success: true, data: { hasPassword: true } }),
    );
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          success: false,
          error: { message: "Current password could not be verified." },
        },
        { status: 400 },
      ),
    );
    await render(h(AccountPasswordForm));
    expect(container.querySelector("h2")?.textContent).toBe("Change password");
    expect(container.querySelector('a[href="/forgot-password"]')).toBeNull();
    await newPasswords();
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(alertText()).toContain("Enter your current application password");
    await fill("currentPassword", "current application password");
    await submit();
    expect(requestBody(1)).toEqual({
      currentPassword: "current application password",
      newPassword: password,
      confirmPassword: password,
    });
    expect(alertText()).toContain("could not be verified");
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(store.getState().workspaceUi.status).toBe("active");
  });

  it.each([
    ["short", "short", "between 12 and 128"],
    ["a".repeat(129), "a".repeat(129), "between 12 and 128"],
    [password, "a different long password", "do not match"],
  ])(
    "validates password length and confirmation before saving (%s)",
    async (value, confirm, error) => {
      fetchMock.mockResolvedValueOnce(
        Response.json({ success: true, data: { hasPassword: false } }),
      );
      await render(h(AccountPasswordForm));
      await newPasswords(value, confirm);
      await submit();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(alertText()).toContain(error);
      expect(input("newPassword").value).toBe(value);
      expect(auth.signOut).not.toHaveBeenCalled();
    },
  );

  it("fences duplicate password writes while saving", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ success: true, data: { hasPassword: false } }),
    );
    let release!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    await render(h(AccountPasswordForm));
    await newPasswords();
    await submit();
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(input("newPassword").disabled).toBe(true);
    await act(async () =>
      release(Response.json({ success: true, data: { message: "Saved" } })),
    );
    expect(auth.signOut).toHaveBeenCalledOnce();
  });

  it.each(["EMPLOYEE", "MANAGE_DRIVER", "ADMIN", "SUPER_ADMIN"])(
    "links %s users to the same account security page",
    async (role) => {
      window.history.replaceState(null, "", "/account/security");
      await render(
        h(AppShell, {
          mode:
            role === "EMPLOYEE" || role === "MANAGE_DRIVER"
              ? "employee"
              : "admin",
          user: {
            id: "public-person-id",
            profileSlug: "person",
            email: "person@example.test",
            name: "Person",
            role,
          },
          children: "Settings",
        }),
      );
      const link = container.querySelector('a[href="/account/security"]');
      expect(link?.textContent).toBe("Account security");
      expect(link?.getAttribute("aria-current")).toBe("page");
      const profileLink = container.querySelector('a[href="/profile/person"]');
      expect(profileLink?.textContent).toBe("Public profile");
    },
  );
});
