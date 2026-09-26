// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider } from "react-redux";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublicProfileEditor } from "@/components/public-profile-editor";
import { api, ClientRequestError } from "@/lib/client/request";
import {
  makeStore,
  clearWorkspaceData,
  type AppStore,
} from "@/store/make-store";
import type { ManagedPublicProfile } from "@/modules/public-profile/management";

vi.mock("@/lib/client/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client/request")>()),
  api: vi.fn(),
}));
vi.mock("@/lib/client/alerts", () => ({
  enqueueNotification: vi.fn(() => () => {}),
}));

const profile: ManagedPublicProfile = {
  id: "test-user",
  name: "Example Person",
  designation: "Engineer",
  phone: "+880 1700000000",
  bloodGroup: "AB+",
  publicDepartment: "Engineering",
  homeAddress: "123 Home Street\nDhaka",
  dateOfBirth: "1993-07-21",
};
let root: Root;
let container: HTMLDivElement;
let store: AppStore;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api)
    .mockReset()
    .mockImplementation(async (_url, options) =>
      options?.method === "PATCH"
        ? { ...profile, ...JSON.parse(String(options.body)) }
        : profile,
    );
  store = makeStore();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await render();
});

async function render() {
  await act(async () => {
    root.render(
      h(Provider, {
        store,
        children: h(PublicProfileEditor, { profile }),
      }),
    );
  });
}

afterEach(async () => {
  await act(async () => root.unmount());
  clearWorkspaceData(store);
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function input(name: string) {
  return container.querySelector<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >(`[name="${name}"]`)!;
}
function form() {
  return container.querySelector("form")!;
}
function submitEvent() {
  form().dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
}
async function submit() {
  await act(async () => submitEvent());
}

it("shows all requested profile fields with the saved date and blood group", () => {
  for (const [name, value] of Object.entries(profile)) {
    if (name !== "id") expect(input(name).value).toBe(value);
  }
  expect(input("dateOfBirth").type).toBe("date");
  expect(input("phone").type).toBe("tel");
  expect(input("homeAddress").tagName).toBe("TEXTAREA");
  expect(
    [...input("bloodGroup").querySelectorAll("option")].map(
      (option) => option.value,
    ),
  ).toEqual(["", "A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]);
  expect(container.textContent).toContain("visible to anyone");
  expect(api).not.toHaveBeenCalled();
});

it("saves only the seven public fields and clears optional fields with null", async () => {
  input("name").value = "  Updated Person  ";
  input("designation").value = "";
  input("phone").value = "";
  input("homeAddress").value = "";
  input("dateOfBirth").value = "";
  input("bloodGroup").value = "";
  input("publicDepartment").value = "  Operations  ";
  const dispatch = vi.spyOn(store, "dispatch");
  await render();
  await submit();
  expect(api).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api).mock.calls[0][0]).toBe(
    "/api/admin/users/test-user/public-profile",
  );
  const options = vi.mocked(api).mock.calls[0][1]!;
  expect(options.method).toBe("PATCH");
  expect(JSON.parse(String(options.body))).toEqual({
    name: "Updated Person",
    designation: null,
    phone: null,
    bloodGroup: null,
    publicDepartment: "Operations",
    homeAddress: null,
    dateOfBirth: null,
  });
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ type: "workspaceApi/invalidateTags" }),
  );
  expect(container.textContent).toContain("Public profile saved.");
  expect(input("name").value).toBe("Updated Person");
  expect(input("dateOfBirth").value).toBe("");
});

it.each([
  ["name", "   "],
  ["name", "N".repeat(161)],
  ["designation", "D".repeat(161)],
  ["phone", "1".repeat(41)],
  ["publicDepartment", "D".repeat(161)],
  ["homeAddress", "H".repeat(1001)],
  ["dateOfBirth", "2999-12-31"],
])("rejects invalid %s before sending a save", async (name, value) => {
  input(name).value = value;
  await submit();
  expect(api).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});

it("blocks duplicate submissions and disables editing while the save is pending", async () => {
  let resolve!: (value: ManagedPublicProfile) => void;
  vi.mocked(api).mockReturnValue(
    new Promise<ManagedPublicProfile>((done) => {
      resolve = done;
    }),
  );
  await act(async () => {
    submitEvent();
    submitEvent();
  });
  expect(api).toHaveBeenCalledTimes(1);
  expect(form().getAttribute("aria-busy")).toBe("true");
  for (const field of form().querySelectorAll("input,select,textarea"))
    expect((field as HTMLInputElement).disabled).toBe(true);
  await act(async () => resolve(profile));
  expect(form().getAttribute("aria-busy")).toBe("false");
});

it("keeps submitted values and displays a rejected server save", async () => {
  vi.mocked(api).mockRejectedValueOnce(
    new ClientRequestError({
      status: 403,
      code: "FORBIDDEN",
      message: "Only Super Admin can edit public profiles.",
    }),
  );
  input("designation").value = "Updated designation";
  await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Only Super Admin can edit public profiles.",
  );
  expect(input("designation").value).toBe("Updated designation");
  expect(container.textContent).not.toContain("Public profile saved.");
});

it("requires a fresh read after an uncertain save before allowing another save", async () => {
  vi.mocked(api).mockRejectedValueOnce(
    new ClientRequestError({
      status: "FETCH_ERROR",
      code: "NETWORK_ERROR",
      message: "Unable to reach the server.",
    }),
  );
  input("designation").value = "Uncertain edit";
  await submit();
  await submit();
  expect(api).toHaveBeenCalledTimes(1);
  expect(input("name").disabled).toBe(true);
  const reload = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Reload current profile",
  )!;
  expect(reload).toBeDefined();
  await act(async () => reload.click());
  expect(api).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api).mock.calls[1][1]?.method).toBeUndefined();
  expect(input("designation").value).toBe(profile.designation);
  expect(input("name").disabled).toBe(false);
  await submit();
  expect(api).toHaveBeenCalledTimes(3);
});
