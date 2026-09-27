import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  session: vi.fn(),
  user: vi.fn(),
  getBalance: vi.fn(),
  addBalance: vi.fn(),
  assertSameOrigin: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({
  db: {
    session: { findFirst: mocks.session },
    user: { findUnique: mocks.user },
  },
}));
vi.mock("@/lib/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  rateLimit: mocks.rateLimit,
}));
vi.mock("@/modules/drive-costs/balance", () => ({
  getDriveCostBalance: mocks.getBalance,
  addDriveCostBalance: mocks.addBalance,
}));

import { GET, POST } from "@/app/api/admin/drive-costs/balance/route";
import { DomainError } from "@/lib/errors";
import type { Role } from "@/modules/auth/authorization";

function user(role: Role) {
  return {
    id: "user-1",
    role,
    status: "ACTIVE",
    googleAccountId: "google-1",
    employee: { id: "employee-1" },
  };
}

const validAddition = {
  requestId: "30b56130-1ef2-4f1f-b8f7-50f42ec79f2d",
  amount: "250.25",
  note: "Fuel budget",
};

function add(body: unknown = validAddition) {
  return POST(
    new Request(
      "https://attendance.example.test/api/admin/drive-costs/balance",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  );
}

const actions = [
  { name: "view balance", invoke: GET, operation: mocks.getBalance },
  { name: "add balance", invoke: () => add(), operation: mocks.addBalance },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({
    user: { id: "user-1" },
    sessionId: "session-1",
  });
  mocks.session.mockResolvedValue({
    id: "session-1",
    expires: new Date("2030-01-01T00:00:00Z"),
  });
  mocks.user.mockResolvedValue(user("SUPER_ADMIN"));
  mocks.getBalance.mockResolvedValue({
    balance: "-25.50",
    totalAdded: "100.00",
    totalPaid: "125.50",
  });
  mocks.addBalance.mockResolvedValue({
    id: "addition-1",
    amount: validAddition.amount,
    note: validAddition.note,
    createdAt: "2026-09-27T10:00:00.000Z",
  });
});

describe("drive cost balance API authorization", () => {
  it.each(["MANAGE_DRIVER", "ADMIN", "SUPER_ADMIN"] as const)(
    "allows %s to view a negative balance",
    async (role) => {
      mocks.user.mockResolvedValue(user(role));

      const response = await GET();

      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({
        success: true,
        data: {
          balance: "-25.50",
          totalAdded: "100.00",
          totalPaid: "125.50",
        },
      });
      expect(mocks.getBalance).toHaveBeenCalledWith(
        expect.objectContaining({ id: "user-1", role }),
      );
      expect(mocks.addBalance).not.toHaveBeenCalled();
    },
  );

  it.each(actions)(
    "denies an employee permission to $name before the service runs",
    async ({ invoke, operation }) => {
      mocks.user.mockResolvedValue(user("EMPLOYEE"));

      const response = await invoke();

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: "FORBIDDEN" },
      });
      expect(operation).not.toHaveBeenCalled();
      expect(mocks.rateLimit).not.toHaveBeenCalled();
    },
  );

  it.each(actions)(
    "requires a current session to $name",
    async ({ invoke, operation }) => {
      mocks.session.mockResolvedValue(null);

      const response = await invoke();

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: "UNAUTHENTICATED" },
      });
      expect(mocks.session).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: "session-1",
            userId: "user-1",
            expires: { gt: expect.any(Date) },
          },
        }),
      );
      expect(mocks.user).not.toHaveBeenCalled();
      expect(operation).not.toHaveBeenCalled();
      expect(mocks.rateLimit).not.toHaveBeenCalled();
    },
  );

  it.each(actions)(
    "denies an inactive super admin permission to $name",
    async ({ invoke, operation }) => {
      mocks.user.mockResolvedValue({
        ...user("SUPER_ADMIN"),
        status: "INACTIVE",
      });

      const response = await invoke();

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: "USER_INACTIVE" },
      });
      expect(operation).not.toHaveBeenCalled();
      expect(mocks.rateLimit).not.toHaveBeenCalled();
    },
  );

  it.each(actions)(
    "requires sign-in to $name",
    async ({ invoke, operation }) => {
      mocks.auth.mockResolvedValue(null);

      expect((await invoke()).status).toBe(401);
      expect(mocks.session).not.toHaveBeenCalled();
      expect(mocks.user).not.toHaveBeenCalled();
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it.each(["MANAGE_DRIVER", "ADMIN"] as const)(
    "denies %s balance additions before validating the payload",
    async (role) => {
      mocks.user.mockResolvedValue(user(role));

      expect((await add({ amount: "invalid" })).status).toBe(403);
      expect(mocks.addBalance).not.toHaveBeenCalled();
      expect(mocks.rateLimit).not.toHaveBeenCalled();
    },
  );

  it("allows a super admin to add a validated amount and note", async () => {
    const response = await add({
      ...validAddition,
      amount: " 250.25 ",
      note: " Fuel budget ",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { id: "addition-1", amount: "250.25", note: "Fuel budget" },
    });
    expect(mocks.assertSameOrigin).toHaveBeenCalledOnce();
    expect(mocks.rateLimit).toHaveBeenCalledWith("admin-write:user-1", 120, 60);
    expect(mocks.addBalance).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-1", role: "SUPER_ADMIN" }),
      validAddition,
    );
    expect(mocks.getBalance).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { ...validAddition, amount: "0.00" },
    { ...validAddition, amount: "-1.00" },
    { ...validAddition, amount: "0.001" },
    { ...validAddition, amount: 250.25 },
    { ...validAddition, requestId: "not-a-uuid" },
    { ...validAddition, createdById: "another-user" },
    { ...validAddition, balance: "1000000.00" },
  ])("rejects an invalid or extra-field payload: %j", async (body) => {
    const response = await add(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(mocks.addBalance).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before adding balance", async () => {
    const response = await POST(
      new Request(
        "https://attendance.example.test/api/admin/drive-costs/balance",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        },
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "INVALID_JSON" },
    });
    expect(mocks.addBalance).not.toHaveBeenCalled();
  });

  it("honors origin rejection before authorization or balance access", async () => {
    mocks.assertSameOrigin.mockImplementation(() => {
      throw new DomainError("FORBIDDEN", "Request origin is not allowed.", 403);
    });

    expect((await add()).status).toBe(403);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.addBalance).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("blocks additions immediately after a super admin is demoted", async () => {
    expect((await add()).status).toBe(200);
    mocks.user.mockResolvedValue(user("ADMIN"));

    expect((await add()).status).toBe(403);
    expect(mocks.addBalance).toHaveBeenCalledOnce();
  });
});
