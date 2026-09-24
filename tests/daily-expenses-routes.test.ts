import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@/lib/errors";
import { requireUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import * as service from "@/modules/daily-expenses/service";
import { GET as summary } from "@/app/api/daily-expenses/summary/route";
import { GET as history } from "@/app/api/daily-expenses/transactions/route";
import {
  GET as categories,
  POST as createCategory,
} from "@/app/api/daily-expenses/categories/route";
import { POST as balance } from "@/app/api/daily-expenses/balance/route";
import { POST as expense } from "@/app/api/daily-expenses/expenses/route";
import { PATCH as updateCategory } from "@/app/api/daily-expenses/categories/[id]/route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/security", () => ({
  assertSameOrigin: vi.fn(),
  rateLimit: vi.fn(),
}));
vi.mock("@/modules/daily-expenses/service", () => ({
  getDailyExpensesSummary: vi.fn(),
  listDailyExpenseTransactions: vi.fn(),
  listDailyExpenseCategories: vi.fn(),
  createDailyExpenseCategory: vi.fn(),
  updateDailyExpenseCategory: vi.fn(),
  addDailyExpenseBalance: vi.fn(),
  addDailyExpense: vi.fn(),
}));

const request = (method = "GET", body?: unknown) =>
  new Request(
    "https://attendance.example.test/api/daily-expenses/transactions",
    {
      method,
      headers: {
        "content-type": "application/json",
        origin: "https://attendance.example.test",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
const context = { params: Promise.resolve({ id: "category" }) };
const routes: [string, () => Promise<Response>][] = [
  ["summary", summary],
  ["history", () => history(request())],
  ["categories", categories],
  ["create category", () => createCategory(request("POST", {}))],
  ["update category", () => updateCategory(request("PATCH", {}), context)],
  ["balance", () => balance(request("POST", {}))],
  ["expense", () => expense(request("POST", {}))],
];
function actor(role: string) {
  vi.mocked(requireUser).mockResolvedValue({
    id: "session-actor",
    role,
    status: "ACTIVE",
    employee: null,
  } as Awaited<ReturnType<typeof requireUser>>);
}
beforeEach(() => {
  vi.resetAllMocks();
  actor("ADMIN");
});

describe("Daily Expenses API boundaries", () => {
  it.each(routes)("requires a session for %s", async (_name, run) => {
    vi.mocked(requireUser).mockRejectedValue(
      new DomainError("UNAUTHENTICATED", "Sign in", 401),
    );
    const response = await run();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    for (const operation of Object.values(service))
      expect(operation).not.toHaveBeenCalled();
  });
  it.each(routes)(
    "blocks employee and driver manager access to %s",
    async (_name, run) => {
      for (const role of ["EMPLOYEE", "MANAGE_DRIVER"]) {
        actor(role);
        expect((await run()).status).toBe(403);
      }
      for (const operation of Object.values(service))
        expect(operation).not.toHaveBeenCalled();
    },
  );
  it.each(["ADMIN", "SUPER_ADMIN"])(
    "permits %s without an Employee profile and returns no-store JSON",
    async (role) => {
      actor(role);
      vi.mocked(service.getDailyExpensesSummary).mockResolvedValue({
        currentBalance: "-50.00",
        totalBalanceAdded: "100.00",
        totalExpenses: "150.00",
        today: "2026-09-24",
        ledger: { id: "ledger", currency: "BDT", timezone: "Asia/Dhaka" },
      });
      const response = await summary();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        success: true,
        data: { currentBalance: "-50.00" },
      });
      expect(service.getDailyExpensesSummary).toHaveBeenCalledWith(
        expect.objectContaining({ id: "session-actor", employee: null }),
      );
    },
  );
  it("checks origin before mutations reach business logic", async () => {
    vi.mocked(assertSameOrigin).mockImplementation(() => {
      throw new DomainError("INVALID_ORIGIN", "Invalid origin", 403);
    });
    for (const run of [
      () => balance(request("POST", {})),
      () => expense(request("POST", {})),
      () => createCategory(request("POST", {})),
      () => updateCategory(request("PATCH", {}), context),
    ]) {
      expect((await run()).status).toBe(403);
    }
    for (const operation of Object.values(service))
      expect(operation).not.toHaveBeenCalled();
  });
  it("rejects client actor/ledger injection and invalid amounts before writing", async () => {
    const base = {
      amount: "1.00",
      date: "2026-09-24",
      idempotencyKey: randomUUID(),
    };
    for (const body of [
      { ...base, amount: 1 },
      { ...base, amount: "1.001" },
      { ...base, creatorId: "forged", ledgerId: "other" },
    ]) {
      const response = await balance(request("POST", body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "VALIDATION_ERROR" },
      });
    }
    expect(service.addDailyExpenseBalance).not.toHaveBeenCalled();
  });
  it("forwards the server actor and normalized validated payload", async () => {
    const body = {
      amount: "1.2",
      date: "2026-09-24",
      idempotencyKey: randomUUID(),
      note: "  source  ",
    };
    await balance(request("POST", body));
    expect(service.addDailyExpenseBalance).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-actor" }),
      expect.objectContaining({
        amount: "1.20",
        note: "source",
        idempotencyKey: body.idempotencyKey,
      }),
    );
  });
});
