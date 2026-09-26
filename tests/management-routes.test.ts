import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@/lib/errors";
import { requireAdmin, requireSuperAdmin } from "@/lib/auth";
import { GET as list, POST as create } from "@/app/api/admin/[resource]/route";
import {
  GET as detail,
  PATCH as update,
  DELETE as remove,
} from "@/app/api/admin/[resource]/[id]/route";
import { GET as dashboard } from "@/app/api/admin/dashboard/route";
import { GET as reports } from "@/app/api/admin/reports/route";
import { GET as defaults } from "@/app/api/admin/office-defaults/route";
import { POST as createCorrection } from "@/app/api/admin/attendance/route";
import { PATCH as correction } from "@/app/api/admin/attendance/[id]/route";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(),
  requireDriveCostManager: vi.fn(),
  requireSuperAdmin: vi.fn(),
}));
vi.mock("@/lib/security", () => ({
  assertSameOrigin: vi.fn(),
  rateLimit: vi.fn(),
}));

describe("admin API authorization", () => {
  beforeEach(() => {
    vi.mocked(requireAdmin).mockRejectedValue(
      new DomainError("FORBIDDEN", "Administrator access is required.", 403),
    );
    vi.mocked(requireSuperAdmin).mockRejectedValue(
      new DomainError(
        "FORBIDDEN",
        "Super administrator access is required.",
        403,
      ),
    );
  });
  const context = {
    params: Promise.resolve({ resource: "employees", id: "employee-id" }),
  };
  const request = (method = "GET") =>
    new Request("https://attendance.example.test/api/admin/employees", {
      method,
    });
  const cases: [string, () => Promise<Response>][] = [
    ["list", () => list(request(), context)],
    ["create", () => create(request("POST"), context)],
    ["detail", () => detail(request(), context)],
    ["update", () => update(request("PATCH"), context)],
    ["remove", () => remove(request("DELETE"), context)],
    ["dashboard", () => dashboard()],
    ["reports", () => reports(request())],
    ["policy defaults", () => defaults()],
    ["new correction", () => createCorrection(request("POST"))],
    ["existing correction", () => correction(request("PATCH"), context)],
  ];
  it.each(cases)(
    "rejects employee access to %s before database work",
    async (_name, action) => {
      const response = await action();
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: "FORBIDDEN" },
      });
    },
  );

  it.each([
    ["new employee", () => create(request("POST"), context)],
    ["new correction", () => createCorrection(request("POST"))],
    ["existing correction", () => correction(request("PATCH"), context)],
  ] as const)(
    "requires super administrator access for %s",
    async (_name, action) => {
      vi.mocked(requireAdmin).mockClear();
      vi.mocked(requireSuperAdmin).mockClear();
      const response = await action();
      expect(response.status).toBe(403);
      expect(requireSuperAdmin).toHaveBeenCalledOnce();
      expect(requireAdmin).not.toHaveBeenCalled();
    },
  );

  it("rejects regular administrators creating employees at the HTTP boundary", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({
      id: "regular-admin",
      role: "ADMIN",
    } as Awaited<ReturnType<typeof requireAdmin>>);
    vi.mocked(requireAdmin).mockClear();
    vi.mocked(requireSuperAdmin).mockClear();
    const response = await create(request("POST"), context);
    expect(response.status).toBe(403);
    expect(requireSuperAdmin).toHaveBeenCalledOnce();
    expect(requireAdmin).not.toHaveBeenCalled();
  });
});
