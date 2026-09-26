import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  transport: vi.fn(),
  send: vi.fn(),
  close: vi.fn(),
  env: vi.fn(),
}));
vi.mock("nodemailer", () => ({
  default: { createTransport: mocks.transport },
}));
vi.mock("@/lib/env", () => ({ getEnv: mocks.env }));
import { sendPasswordResetEmail } from "@/lib/email";
const config = {
  AUTH_URL: "https://attendance.example.test",
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: 587,
  SMTP_SECURE: false,
  SMTP_USER: "application-mail-user",
  SMTP_PASSWORD: "application-mail-secret",
  EMAIL_FROM: "attendance@example.test",
};

describe("SMTP password reset delivery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.env.mockReturnValue(config);
    mocks.transport.mockReturnValue({
      sendMail: mocks.send,
      close: mocks.close,
    });
    mocks.send.mockResolvedValue({
      accepted: ["recipient@example.test"],
      rejected: [],
    });
  });
  it("uses configured SMTP with TLS, no debug payloads, bounded waits, and a fragment link", async () => {
    const token = "a".repeat(64);
    await sendPasswordResetEmail("recipient@example.test", token);
    expect(mocks.transport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: config.SMTP_HOST,
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
        logger: false,
        debug: false,
        connectionTimeout: 10_000,
        socketTimeout: 15_000,
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
    );
    const mail = mocks.send.mock.calls[0][0];
    expect(mail.to).toEqual({ name: "", address: "recipient@example.test" });
    expect(mail.text).toContain(
      `https://attendance.example.test/reset-password#token=${token}`,
    );
    expect(mail.text).toContain("Never enter your Google password");
    expect(mail.text).not.toContain(config.SMTP_PASSWORD);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("does not silently send or print tokens when SMTP is unavailable", async () => {
    mocks.env.mockReturnValue({ AUTH_URL: config.AUTH_URL });
    await expect(
      sendPasswordResetEmail("recipient@example.test", "a".repeat(64)),
    ).rejects.toThrow("not configured");
    expect(mocks.transport).not.toHaveBeenCalled();
  });
  it("supports implicit TLS and configured unauthenticated mail relays", async () => {
    mocks.env.mockReturnValue({
      ...config,
      SMTP_SECURE: true,
      SMTP_PORT: 465,
      SMTP_USER: undefined,
      SMTP_PASSWORD: undefined,
    });
    await sendPasswordResetEmail("recipient@example.test", "a".repeat(64));
    const options = mocks.transport.mock.calls[0][0];
    expect(options).toMatchObject({
      port: 465,
      secure: true,
      requireTLS: false,
    });
    expect(options).not.toHaveProperty("auth");
  });
  it("rejects unaccepted delivery and closes the transport after SMTP failure", async () => {
    mocks.send.mockResolvedValueOnce({
      accepted: [],
      rejected: ["recipient@example.test"],
    });
    await expect(
      sendPasswordResetEmail("recipient@example.test", "a".repeat(64)),
    ).rejects.toThrow("not accepted");
    mocks.send.mockRejectedValueOnce(new Error("SMTP unavailable"));
    await expect(
      sendPasswordResetEmail("recipient@example.test", "a".repeat(64)),
    ).rejects.toThrow("SMTP unavailable");
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });
});
