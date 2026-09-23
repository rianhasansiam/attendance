import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  revalidate: vi.fn(),
  lookup: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: mocks.auth,
  requireDriveCostManager: mocks.auth,
}));
vi.mock("@/lib/security", () => ({
  assertSameOrigin: vi.fn(),
  rateLimit: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidateTag: mocks.revalidate }));
vi.mock("@/modules/management/service", async (original) => ({
  ...(await original<object>()),
  createRecord: mocks.create,
  updateRecord: mocks.update,
  removeRecord: mocks.remove,
}));
vi.mock("@/modules/management/lookups", async () => {
  const { z } = await import("zod");
  return {
    listLookupOptions: mocks.lookup,
    lookupResourceSchema: z.enum([
      "departments",
      "offices",
      "shifts",
      "employees",
    ]),
  };
});
import { POST } from "@/app/api/admin/[resource]/route";
import { PATCH, DELETE } from "@/app/api/admin/[resource]/[id]/route";
import { GET } from "@/app/api/admin/lookups/[resource]/route";
import { CACHE_TAGS } from "@/lib/cache/tags";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ id: "admin", role: "ADMIN" });
  for (const mutation of [mocks.create, mocks.update, mocks.remove])
    mutation.mockResolvedValue({ id: "record-1" });
  mocks.lookup.mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 100,
  });
});
const context = (resource: string) => ({
  params: Promise.resolve({ resource, id: "record-1" }),
});
function request(method: string) {
  return new Request("http://localhost/api/admin/offices", {
    method,
    ...(method !== "DELETE" && method !== "GET"
      ? { body: "{}", headers: { "Content-Type": "application/json" } }
      : {}),
  });
}

describe("display cache mutation boundary", () => {
  it.each(["departments", "offices", "shifts"] as const)(
    "expires only %s after successful writes",
    async (resource) => {
      for (const [method, handler] of [
        ["POST", POST],
        ["PATCH", PATCH],
        ["DELETE", DELETE],
      ] as const) {
        mocks.revalidate.mockClear();
        const response = await handler(request(method), context(resource));
        expect(response.status).toBe(200);
        expect(mocks.revalidate).toHaveBeenCalledExactlyOnceWith(
          CACHE_TAGS[resource],
          { expire: 0 },
        );
      }
    },
  );
  it("does not invalidate while the transaction is pending or after rollback", async () => {
    let reject!: (reason: unknown) => void;
    const transaction = new Promise((_, failure) => {
      reject = failure;
    });
    mocks.update.mockReturnValue(transaction);
    const response = PATCH(request("PATCH"), context("offices"));
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
    expect(mocks.revalidate).not.toHaveBeenCalled();
    reject(new DomainError("CONFLICT", "Transaction rolled back", 409));
    expect((await response).status).toBe(409);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("does not invalidate labels after a dynamic security-resource mutation", async () => {
    expect((await PATCH(request("PATCH"), context("devices"))).status).toBe(
      200,
    );
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("reauthorizes every lookup request, including after an earlier successful response", async () => {
    expect((await GET(request("GET"), context("offices"))).status).toBe(200);
    mocks.auth.mockRejectedValue(
      new DomainError("FORBIDDEN", "Account revoked", 403),
    );
    const denied = await GET(request("GET"), context("offices"));
    expect(denied.status).toBe(403);
    expect(denied.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.lookup).toHaveBeenCalledOnce();
  });
});
