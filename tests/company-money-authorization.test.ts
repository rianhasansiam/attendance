import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  session: vi.fn(),
  user: vi.fn(),
  overview: vi.fn(),
  record: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  origin: vi.fn(),
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
  assertSameOrigin: mocks.origin,
  rateLimit: mocks.rateLimit,
}));
vi.mock("@/modules/company-money/service", () => ({
  getCompanyMoneyOverview: mocks.overview,
  recordCompanyMoneyTransaction: mocks.record,
  updateCompanyMoneyTransaction: mocks.update,
  deleteCompanyMoneyTransaction: mocks.delete,
}));

import { GET, POST } from "@/app/api/admin/company-money/route";
import { PATCH, DELETE } from "@/app/api/admin/company-money/[id]/route";
import { DomainError } from "@/lib/errors";
import type { Role } from "@prisma/client";

const url = "https://attendance.example.test/api/admin/company-money";
const valid = {
  requestId: "30b56130-1ef2-4f1f-b8f7-50f42ec79f2d",
  type: "ADD",
  amount: "250.25",
  date: "2026-10-17",
  note: "Company funds",
};

function user(role: Role) {
  return {
    id: "user-1",
    role,
    status: "ACTIVE",
    googleAccountId: "google-1",
    employee: null,
  };
}

function add(body: unknown = valid) {
  return POST(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function edit(body: unknown = { ...valid, expectedVersion: 1 }) {
  return PATCH(
    new Request(`${url}/transaction-1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "transaction-1" }) },
  );
}

function remove(
  body: unknown = { requestId: valid.requestId, expectedVersion: 1 },
) {
  return DELETE(
    new Request(`${url}/transaction-1`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "transaction-1" }) },
  );
}

const actions = [
  {
    name: "read",
    invoke: () => GET(new Request(url)),
    operation: mocks.overview,
  },
  { name: "write", invoke: () => add(), operation: mocks.record },
  { name: "edit", invoke: () => edit(), operation: mocks.update },
  { name: "delete", invoke: () => remove(), operation: mocks.delete },
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
  mocks.overview.mockResolvedValue({
    balance: "0.00",
    totalAdded: "0.00",
    totalRemoved: "0.00",
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
  });
  mocks.record.mockResolvedValue({ id: "transaction-1", ...valid });
  mocks.update.mockResolvedValue({ id: "transaction-1", ...valid, version: 2 });
  mocks.delete.mockResolvedValue({ id: "transaction-1" });
});

describe("company money API authorization", () => {
  it.each(["ADMIN", "EMPLOYEE", "MANAGE_DRIVER"] as const)(
    "blocks %s edits and deletions before validating the body",
    async (role) => {
      mocks.user.mockResolvedValue(user(role));
      expect((await edit({})).status).toBe(403);
      expect((await remove({})).status).toBe(403);
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.delete).not.toHaveBeenCalled();
      expect(mocks.rateLimit).not.toHaveBeenCalled();
    },
  );

  it("lets a super admin edit and delete a validated record", async () => {
    expect((await edit()).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-1", role: "SUPER_ADMIN" }),
      "transaction-1",
      { ...valid, expectedVersion: 1 },
    );
    const response = await remove();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { id: "transaction-1" },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.delete).toHaveBeenCalledWith(
      expect.objectContaining({ role: "SUPER_ADMIN" }),
      "transaction-1",
      { requestId: valid.requestId, expectedVersion: 1 },
    );
    expect(mocks.rateLimit).toHaveBeenCalledWith("admin-write:user-1", 120, 60);
    expect(mocks.origin).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed edit/delete versions and forged metadata", async () => {
    for (const changed of [
      { expectedVersion: undefined },
      { expectedVersion: 0 },
      { version: 2 },
      { createdById: "forged" },
    ]) {
      expect(
        (await edit({ ...valid, expectedVersion: 1, ...changed })).status,
      ).toBe(400);
      expect(
        (
          await remove({
            requestId: valid.requestId,
            expectedVersion: 1,
            ...changed,
          })
        ).status,
      ).toBe(400);
    }
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("rejects cross-origin edits and deletes before authenticating", async () => {
    mocks.origin.mockImplementation(() => {
      throw new DomainError("INVALID_ORIGIN", "Invalid origin.", 403);
    });
    expect((await edit()).status).toBe(403);
    expect((await remove()).status).toBe(403);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });
  it.each(["ADMIN", "SUPER_ADMIN"] as const)(
    "allows %s to read the shared balance with pagination",
    async (role) => {
      mocks.user.mockResolvedValue(user(role));
      const response = await GET(new Request(`${url}?page=2&pageSize=10`));
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        success: true,
        data: { balance: "0.00", totalAdded: "0.00", totalRemoved: "0.00" },
      });
      expect(mocks.overview).toHaveBeenCalledWith(
        expect.objectContaining({ role }),
        { page: 2, pageSize: 10 },
      );
    },
  );

  it.each(["EMPLOYEE", "MANAGE_DRIVER"] as const)(
    "blocks %s from reading company money",
    async (role) => {
      mocks.user.mockResolvedValue(user(role));
      expect((await GET(new Request(url))).status).toBe(403);
      expect(mocks.overview).not.toHaveBeenCalled();
    },
  );

  it.each(["ADMIN", "EMPLOYEE", "MANAGE_DRIVER"] as const)(
    "blocks %s changes before body validation",
    async (role) => {
      mocks.user.mockResolvedValue(user(role));
      expect((await add({ amount: "invalid" })).status).toBe(403);
      expect(mocks.record).not.toHaveBeenCalled();
      expect(mocks.rateLimit).not.toHaveBeenCalled();
    },
  );

  it.each(actions)(
    "requires a valid session for $name",
    async ({ invoke, operation }) => {
      mocks.session.mockResolvedValue(null);
      expect((await invoke()).status).toBe(401);
      expect(operation).not.toHaveBeenCalled();
      expect(mocks.user).not.toHaveBeenCalled();
    },
  );

  it.each(actions)(
    "requires sign-in for $name",
    async ({ invoke, operation }) => {
      mocks.auth.mockResolvedValue(null);
      expect((await invoke()).status).toBe(401);
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it.each(actions)(
    "blocks inactive actors from $name",
    async ({ invoke, operation }) => {
      mocks.user.mockResolvedValue({
        ...user("SUPER_ADMIN"),
        status: "INACTIVE",
      });
      expect((await invoke()).status).toBe(403);
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it.each(["ADD", "REMOVE"])("lets a super admin submit %s", async (type) => {
    const response = await add({
      ...valid,
      type,
      amount: " 250.25 ",
      note: " Company funds ",
    });
    expect(response.status).toBe(200);
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-1", role: "SUPER_ADMIN" }),
      { ...valid, type },
    );
    expect(mocks.rateLimit).toHaveBeenCalledWith("admin-write:user-1", 120, 60);
    expect(mocks.origin).toHaveBeenCalledOnce();
  });

  it.each([
    { amount: "0.00" },
    { amount: "-1.00" },
    { amount: "1.001" },
    { amount: 250.25 },
    { requestId: "invalid" },
    { type: "UNKNOWN" },
    { date: undefined },
    { date: "2026-02-29" },
    { date: "2026-10-17T00:00:00.000Z" },
    { createdById: "another-user" },
    { balance: "1000.00" },
  ])("rejects invalid and forged payloads %j", async (changed) => {
    const response = await add({ ...valid, ...changed });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("blocks invalid origins before auth and writes", async () => {
    mocks.origin.mockImplementation(() => {
      throw new DomainError("INVALID_ORIGIN", "Invalid origin.", 403);
    });
    expect((await add()).status).toBe(403);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("returns the domain overdraft error without changing its code", async () => {
    mocks.record.mockRejectedValue(
      new DomainError(
        "INSUFFICIENT_COMPANY_BALANCE",
        "Insufficient company balance.",
        409,
      ),
    );
    const response = await add({ ...valid, type: "REMOVE" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "INSUFFICIENT_COMPANY_BALANCE" },
    });
  });

  it("rejects invalid pagination before reading company money", async () => {
    expect((await GET(new Request(`${url}?pageSize=101`))).status).toBe(400);
    expect(mocks.overview).not.toHaveBeenCalled();
  });
});
