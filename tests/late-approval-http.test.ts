import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@/lib/errors";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  origin: vi.fn(),
  limit: vi.fn(),
  review: vi.fn(),
  list: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireAdmin: mocks.auth }));
vi.mock("@/lib/security", () => ({
  assertSameOrigin: mocks.origin,
  rateLimit: mocks.limit,
}));
vi.mock("@/modules/attendance/late-approval", async (original) => ({
  ...(await original<object>()),
  reviewLateApproval: mocks.review,
  listLateApprovals: mocks.list,
}));
import { PATCH } from "@/app/api/admin/late-approvals/[id]/route";
import { GET } from "@/app/api/admin/late-approvals/route";
const actor = { id: "admin", role: "ADMIN" };
const context = { params: Promise.resolve({ id: "approval" }) };
const request = (body: object) =>
  new Request("https://example.test/api/admin/late-approvals/approval", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      origin: "https://example.test",
    },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue(actor);
  mocks.review.mockResolvedValue({ id: "approval", status: "APPROVED" });
  mocks.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });
});
describe("late approval HTTP boundary", () => {
  it("requires administrator authorization for reads and writes", async () => {
    mocks.auth.mockRejectedValue(
      new DomainError("FORBIDDEN", "Admin required", 403),
    );
    expect((await PATCH(request({ status: "APPROVED" }), context)).status).toBe(
      403,
    );
    expect(
      (await GET(new Request("https://example.test/api/admin/late-approvals")))
        .status,
    ).toBe(403);
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("checks same-origin before authentication or mutations", async () => {
    mocks.origin.mockImplementation(() => {
      throw new DomainError("INVALID_ORIGIN", "Origin required", 403);
    });
    expect((await PATCH(request({ status: "APPROVED" }), context)).status).toBe(
      403,
    );
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
  });
  it.each([
    { status: "PENDING" },
    { status: "APPROVED", reviewedById: "other" },
    { status: "APPROVED", lateMinutes: 0 },
    { status: "APPROVED", reviewNote: "x".repeat(1001) },
  ])("rejects invalid or forged decisions %j", async (body) => {
    expect((await PATCH(request(body), context)).status).toBe(400);
    expect(mocks.review).not.toHaveBeenCalled();
  });
  it("delegates a bounded, trimmed review and returns no-store data", async () => {
    const response = await PATCH(
      request({ status: "APPROVED", reviewNote: "  Accepted.  " }),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.review).toHaveBeenCalledExactlyOnceWith(actor, "approval", {
      status: "APPROVED",
      reviewNote: "Accepted.",
    });
    expect(mocks.limit).toHaveBeenCalledWith("admin-write:admin", 120, 60);
  });
  it("returns a conflict for a concurrent finalized decision", async () => {
    mocks.review.mockRejectedValue(
      new DomainError(
        "LATE_APPROVAL_ALREADY_REVIEWED",
        "Already reviewed",
        409,
      ),
    );
    expect((await PATCH(request({ status: "REJECTED" }), context)).status).toBe(
      409,
    );
  });
  it("validates and bounds list filters", async () => {
    expect(
      (
        await GET(
          new Request(
            "https://example.test/api/admin/late-approvals?status=PENDING&page=2&pageSize=10",
          ),
        )
      ).status,
    ).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(actor, {
      status: "PENDING",
      page: 2,
      pageSize: 10,
    });
    expect(
      (
        await GET(
          new Request(
            "https://example.test/api/admin/late-approvals?pageSize=100000",
          ),
        )
      ).status,
    ).toBe(400);
  });
});
