// @vitest-environment jsdom
import { Activity, StrictMode, act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProfileRefresh } from "@/components/profile-refresh";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
let root: Root;
let container: HTMLDivElement;
let visible = true;
let online = true;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  visible = true;
  online = true;
  router.refresh.mockClear();
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
    visible ? "visible" : "hidden",
  );
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const tree = (mode: "visible" | "hidden") =>
  h(StrictMode, {
    children: h(Activity, { mode, children: h(ProfileRefresh) }),
  });
async function render(mode: "visible" | "hidden") {
  await act(async () => {
    root.render(tree(mode));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150);
  });
}

it("keeps the first server read, then revalidates retained profile on reveal with clean event subscriptions", async () => {
  await render("visible");
  expect(router.refresh).not.toHaveBeenCalled();
  await render("hidden");
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(150);
  expect(router.refresh).not.toHaveBeenCalled();
  await render("visible");
  expect(router.refresh).toHaveBeenCalledTimes(1);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(150);
  });
  expect(router.refresh).toHaveBeenCalledTimes(2);
  visible = false;
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(150);
  expect(router.refresh).toHaveBeenCalledTimes(2);
  visible = true;
  online = false;
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(150);
  expect(router.refresh).toHaveBeenCalledTimes(2);
  online = true;
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(150);
  expect(router.refresh).toHaveBeenCalledTimes(3);
});
