import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rateLimit: vi.fn() }));
vi.mock("@/lib/security", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    TRUSTED_PROXY_MODE: "nginx",
    TRUSTED_PROXY_SECRET: "test-proxy-secret",
  }),
}));
import { limitPasswordAction } from "@/modules/auth/auth-rate-limit";
beforeEach(() => vi.resetAllMocks());
it("uses trusted ingress IP and separate normalized hashed-account windows", async () => {
  const request = new Request("https://app.test", {
    headers: {
      "x-attendance-proxy-secret": "test-proxy-secret",
      "x-real-ip": "203.0.113.1",
    },
  });
  await limitPasswordAction(request, "login", " User@Example.Test ");
  expect(mocks.rateLimit.mock.calls[0]).toEqual([
    "password:login:ip:203.0.113.1",
    50,
    900,
  ]);
  const key = mocks.rateLimit.mock.calls[1][0];
  expect(key).toMatch(/^password:login:account:[a-f0-9]{64}$/);
  await limitPasswordAction(request, "login", "user@example.test");
  expect(mocks.rateLimit.mock.calls[3][0]).toBe(key);
});
it("ignores spoofed IP headers and uses a shared fallback plus reset token throttling", async () => {
  const request = new Request("https://app.test", {
    headers: { "x-real-ip": "1.2.3.4", "x-forwarded-for": "1.2.3.4" },
  });
  await limitPasswordAction(request, "reset", "a".repeat(64));
  expect(mocks.rateLimit.mock.calls[0]).toEqual([
    "password:reset:ip:unavailable",
    30,
    900,
  ]);
  expect(mocks.rateLimit.mock.calls[1]).toEqual([expect.any(String), 5, 900]);
});
