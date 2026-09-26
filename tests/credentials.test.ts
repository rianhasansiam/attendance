import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@/lib/errors";
const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  verify: vi.fn(),
  limit: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: { user: { findUnique: mocks.find } } }));
vi.mock("@/modules/auth/password", () => ({ verifyPassword: mocks.verify }));
vi.mock("@/modules/auth/auth-rate-limit", () => ({
  limitPasswordAction: mocks.limit,
}));
import { authorizeCredentials } from "@/modules/auth/credentials";
const user = {
  id: "existing-google-user",
  email: "person@example.test",
  name: "Person",
  image: null,
  passwordHash: "private-hash",
  role: "EMPLOYEE",
  status: "ACTIVE",
  employee: { id: "employee" },
  googleAccountId: "google-subject",
};
const request = new Request(
  "https://app.example.test/api/auth/callback/credentials",
  { method: "POST" },
);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.find.mockResolvedValue(user);
  mocks.verify.mockResolvedValue(true);
});
describe("credentials verification", () => {
  it("resolves normalized email to the same pre-existing user without creating User or Account records", async () => {
    const result = await authorizeCredentials(
      {
        email: " Person@Example.Test ",
        password: "application-password",
        role: "SUPER_ADMIN",
        userId: "attacker",
      },
      request,
    );
    expect(result?.user).toEqual({
      id: user.id,
      name: user.name,
      email: user.email,
      image: null,
    });
    expect(result?.user).not.toHaveProperty("passwordHash");
    expect(result?.user).not.toHaveProperty("role");
    expect(mocks.find).toHaveBeenCalledWith({
      where: { email: user.email },
      include: { employee: true },
    });
  });
  it.each([
    null,
    { ...user, passwordHash: null },
    { ...user, status: "INACTIVE" },
    { ...user, status: "SUSPENDED" },
    { ...user, employee: null },
  ])("returns the same failure for absent/ineligible records", async (row) => {
    mocks.find.mockResolvedValue(row);
    expect(
      await authorizeCredentials(
        { email: user.email, password: "application-password" },
        request,
      ),
    ).toBeNull();
    expect(mocks.verify).toHaveBeenCalledOnce();
  });
  it("rejects incorrect passwords and invalid input", async () => {
    mocks.verify.mockResolvedValue(false);
    expect(
      await authorizeCredentials(
        { email: user.email, password: "wrong-password" },
        request,
      ),
    ).toBeNull();
    expect(
      await authorizeCredentials(
        { email: [], password: "application-password" },
        request,
      ),
    ).toBeNull();
    expect(mocks.find).toHaveBeenCalledTimes(1);
  });
  it("throttles before database lookup or expensive verification and fails closed on limiter outage", async () => {
    mocks.limit.mockRejectedValueOnce(
      new DomainError("RATE_LIMITED", "Try again", 429),
    );
    expect(
      await authorizeCredentials(
        { email: user.email, password: "application-password" },
        request,
      ),
    ).toBeNull();
    expect(mocks.find).not.toHaveBeenCalled();
    mocks.limit.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      authorizeCredentials(
        { email: user.email, password: "application-password" },
        request,
      ),
    ).rejects.toThrow("database unavailable");
  });
});
