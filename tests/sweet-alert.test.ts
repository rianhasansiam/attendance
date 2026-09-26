// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SweetAlertOptions, SweetAlertResult } from "sweetalert2";

const mocks = vi.hoisted(() => ({ fire: vi.fn(), close: vi.fn() }));
vi.mock("sweetalert2/dist/sweetalert2.js", () => ({ default: mocks }));

let alerts: typeof import("@/lib/client/alerts");
let finish: (result: Partial<SweetAlertResult<string>>) => void;

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.fire.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mocks.close.mockImplementation(() =>
    finish?.({ isConfirmed: false, isDismissed: true }),
  );
  alerts = await import("@/lib/client/alerts");
});

afterEach(() => {
  alerts.resetAlerts();
  document.body.innerHTML = "";
});

describe("shared SweetAlert coordination", () => {
  it("waits for explicit confirmation and rejects another pending confirmation", async () => {
    const pending = alerts.confirmAction({
      title: "Delete employee?",
      text: '<img src=x onerror="alert(1)">',
      danger: true,
    });
    await vi.waitFor(() => expect(mocks.fire).toHaveBeenCalledOnce());
    expect(mocks.fire.mock.calls[0][0]).toMatchObject({
      titleText: "Delete employee?",
      text: '<img src=x onerror="alert(1)">',
      focusCancel: true,
      allowOutsideClick: false,
    });
    expect(mocks.fire.mock.calls[0][0]).not.toHaveProperty("html");
    await expect(
      alerts.confirmAction({
        title: "Another deletion",
        text: "Do not replace the first",
      }),
    ).resolves.toBe(false);
    expect(mocks.fire).toHaveBeenCalledOnce();
    finish({ isConfirmed: true });
    await expect(pending).resolves.toBe(true);
  });

  it("distinguishes canceled prompts from an accepted empty optional note", async () => {
    const options = {
      title: "Review leave",
      inputLabel: "Review note (optional)",
      maxLength: 1000,
    };
    const canceled = alerts.promptAction(options);
    await vi.waitFor(() => expect(mocks.fire).toHaveBeenCalledTimes(1));
    finish({ isConfirmed: false, isDismissed: true });
    await expect(canceled).resolves.toBeNull();
    const accepted = alerts.promptAction(options);
    await vi.waitFor(() => expect(mocks.fire).toHaveBeenCalledTimes(2));
    const popup = mocks.fire.mock.calls[1][0] as SweetAlertOptions & {
      inputValidator: (value: string) => unknown;
    };
    expect(popup.inputAttributes).toEqual({ maxlength: "1000" });
    expect(popup.inputValidator("")).toBeUndefined();
    expect(popup.inputValidator("x".repeat(1001))).toBeTruthy();
    finish({ isConfirmed: true, value: "" });
    await expect(accepted).resolves.toBe("");
  });

  it("queues background notifications until the active confirmation finishes", async () => {
    const pending = alerts.confirmAction({
      title: "Delete?",
      text: "Confirm deletion",
    });
    await vi.waitFor(() => expect(mocks.fire).toHaveBeenCalledTimes(1));
    const unsubscribe = alerts.enqueueNotification({
      kind: "error",
      message: "A background refresh failed.",
    });
    await Promise.resolve();
    expect(mocks.fire).toHaveBeenCalledTimes(1);
    finish({ isConfirmed: false });
    await pending;
    await vi.waitFor(() => expect(mocks.fire).toHaveBeenCalledTimes(2));
    expect(mocks.fire.mock.calls[1][0]).toMatchObject({
      toast: true,
      text: "A background refresh failed.",
    });
    unsubscribe();
  });

  it("prioritizes confirmation over an existing notification without confirming anything", async () => {
    const unsubscribe = alerts.enqueueNotification({
      kind: "success",
      message: "Saved",
    });
    await vi.waitFor(() => expect(mocks.fire).toHaveBeenCalledTimes(1));
    const pending = alerts.confirmAction({
      title: "Delete?",
      text: "Confirm deletion",
    });
    await vi.waitFor(() => expect(mocks.fire).toHaveBeenCalledTimes(2));
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.fire.mock.calls[1][0]).toMatchObject({ titleText: "Delete?" });
    finish({ isConfirmed: false });
    await expect(pending).resolves.toBe(false);
    unsubscribe();
  });

  it("cancels an already-resolved confirmation when route or session changes before continuation", async () => {
    const pending = alerts.confirmAction({
      title: "Delete?",
      text: "Confirm deletion",
    });
    await vi.waitFor(() => expect(mocks.fire).toHaveBeenCalledTimes(1));
    finish({ isConfirmed: true });
    alerts.resetAlerts();
    await expect(pending).resolves.toBe(false);
  });

  it("does not show notifications after their owner unmounts while a dialog is open", async () => {
    const pending = alerts.confirmAction({
      title: "Delete?",
      text: "Confirm deletion",
    });
    await vi.waitFor(() => expect(mocks.fire).toHaveBeenCalledTimes(1));
    const unsubscribe = alerts.enqueueNotification({
      kind: "success",
      message: "Saved",
    });
    unsubscribe();
    finish({ isConfirmed: false });
    await pending;
    await Promise.resolve();
    expect(mocks.fire).toHaveBeenCalledTimes(1);
  });

  it("fails closed with a visible recovery message if the popup fails to open", async () => {
    mocks.fire.mockRejectedValue(new Error("Unable to open popup"));
    await expect(
      alerts.confirmAction({ title: "Delete?", text: "Confirm deletion" }),
    ).resolves.toBe(false);
    expect(document.getElementById("alert-unavailable")?.textContent).toContain(
      "Reload the page",
    );
  });
});
