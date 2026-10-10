import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), connection: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requirePageUser: mocks.auth }));
vi.mock("next/server", () => ({ connection: mocks.connection }));
vi.mock("@/components/salary-workspace", () => ({
  SalaryWorkspace: () => null,
}));
vi.mock("@/app/loading", () => ({ default: () => null }));
import SalaryPage from "@/app/admin/salary-calculator/page";

beforeEach(() => vi.resetAllMocks());

function authorizedPage() {
  const page = SalaryPage() as ReactElement<{ children: ReactElement }>;
  return (page.props.children.type as () => Promise<ReactElement>)();
}

it.each(["ADMIN", "EMPLOYEE", "MANAGE_DRIVER", "guest"])(
  "enforces super admin authorization before rendering confidential UI for %s",
  async (role) => {
    mocks.auth.mockRejectedValue(new Error(`Forbidden: ${role}`));
    await expect(authorizedPage()).rejects.toThrow("Forbidden");
    expect(mocks.auth).toHaveBeenCalledWith("SUPER_ADMIN");
    expect(mocks.connection).toHaveBeenCalledOnce();
  },
);

it("renders the salary workspace after server super admin authorization", async () => {
  mocks.auth.mockResolvedValue({ role: "SUPER_ADMIN" });
  await expect(authorizedPage()).resolves.toBeDefined();
  expect(mocks.auth).toHaveBeenCalledWith("SUPER_ADMIN");
});
