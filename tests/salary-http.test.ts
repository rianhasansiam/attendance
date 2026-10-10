import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/auth";
import { DomainError } from "@/lib/errors";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import * as service from "@/modules/salary/service";
import { salaryStatementDocx } from "@/modules/salary/docx";
import { GET as list } from "@/app/api/admin/salary/route";
import { POST as settings } from "@/app/api/admin/salary/settings/route";
import { POST as calculate } from "@/app/api/admin/salary/calculate/route";
import { POST as statement } from "@/app/api/admin/salary/statement/route";
import type { SalaryStatementData } from "@/modules/salary/contracts";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/security", () => ({
  assertSameOrigin: vi.fn(),
  rateLimit: vi.fn(),
}));
vi.mock("@/modules/daily-expenses/service", () => ({
  initialConfiguration: () => ({ currency: "BDT", timezone: "Asia/Dhaka" }),
}));
vi.mock("@/modules/salary/service", () => ({
  listSalaryEmployees: vi.fn(),
  saveSalarySettings: vi.fn(),
  calculateSalaries: vi.fn(),
  salaryStatementForExport: vi.fn(),
}));
vi.mock("@/modules/salary/docx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/salary/docx")>()),
  salaryStatementDocx: vi.fn(),
}));

const request = (path: string, body?: unknown) =>
  new Request(`https://attendance.example.test/api/admin/salary${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://attendance.example.test",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const settingsInput = {
  employeeId: "employee1",
  effectiveMonth: "2026-10",
  baseSalary: "30000",
  overtimeHourlyRate: "200",
};
const calculateInput = { employeeIds: ["employee1"], period: "2026-10" };
const statementInput = {
  employeeId: "employee1",
  period: "2026-10",
  token: "server-owned-token",
};
const routes: [string, () => Promise<Response>][] = [
  ["list", () => list(request("?period=2026-10"))],
  ["settings", () => settings(request("/settings", settingsInput))],
  ["calculate", () => calculate(request("/calculate", calculateInput))],
  ["statement", () => statement(request("/statement", statementInput))],
];

function actor(role = "SUPER_ADMIN") {
  vi.mocked(requireUser).mockResolvedValue({
    id: "actor",
    role,
    status: "ACTIVE",
  } as Awaited<ReturnType<typeof requireUser>>);
}
beforeEach(() => {
  vi.resetAllMocks();
  actor();
});
afterEach(() => vi.useRealTimers());

describe("salary HTTP authorization and input boundaries", () => {
  it.each(["ADMIN", "EMPLOYEE", "MANAGE_DRIVER"])(
    "denies every operation to %s before reading salary data",
    async (role) => {
      actor(role);
      for (const [, run] of routes) {
        const response = await run();
        expect(response.status).toBe(403);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      for (const operation of Object.values(service))
        expect(operation).not.toHaveBeenCalled();
      expect(salaryStatementDocx).not.toHaveBeenCalled();
      expect(rateLimit).not.toHaveBeenCalled();
    },
  );
  it.each(routes)("requires an active session for %s", async (_name, run) => {
    vi.mocked(requireUser).mockRejectedValue(
      new DomainError("UNAUTHENTICATED", "Sign in", 401),
    );
    const response = await run();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    for (const operation of Object.values(service))
      expect(operation).not.toHaveBeenCalled();
  });
  it.each(routes.slice(1))(
    "enforces same origin for %s",
    async (_name, run) => {
      vi.mocked(assertSameOrigin).mockImplementation(() => {
        throw new DomainError("INVALID_ORIGIN", "Invalid origin", 403);
      });
      expect((await run()).status).toBe(403);
      for (const operation of Object.values(service))
        expect(operation).not.toHaveBeenCalled();
    },
  );
  it("defaults the month using configured timezone across UTC month boundaries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T19:00:00Z"));
    const response = await list(request("?search=EMP001&officeId=office1"));
    expect(response.status).toBe(200);
    expect(service.listSalaryEmployees).toHaveBeenCalledWith(
      expect.objectContaining({ id: "actor" }),
      {
        period: "2026-10",
        from: "2026-10-01",
        to: "2026-10-31",
        search: "EMP001",
        officeId: "office1",
        page: 1,
        pageSize: 20,
      },
    );
  });
  it("infers the payroll month from a custom range and forwards inclusive dates", async () => {
    const response = await list(
      request("?from=2026-09-19&to=2026-09-30&search=EMP001"),
    );
    expect(response.status).toBe(200);
    expect(service.listSalaryEmployees).toHaveBeenCalledWith(
      expect.objectContaining({ id: "actor" }),
      {
        period: "2026-09",
        from: "2026-09-19",
        to: "2026-09-30",
        search: "EMP001",
        page: 1,
        pageSize: 20,
      },
    );
  });
  it("forwards the selected range to authoritative calculation", async () => {
    const input = {
      employeeIds: ["employee1"],
      period: "2026-09",
      from: "2026-09-19",
      to: "2026-09-30",
    };
    expect((await calculate(request("/calculate", input))).status).toBe(200);
    expect(service.calculateSalaries).toHaveBeenCalledWith(
      expect.objectContaining({ id: "actor" }),
      input,
    );
  });
  it.each([
    { from: "2026-09-19" },
    { from: "2026-09-31", to: "2026-09-30" },
    { from: "2026-09-30", to: "2026-09-19" },
    { from: "2026-09-19", to: "2026-10-01" },
  ])("rejects invalid range %s before salary reads", async (range) => {
    expect(
      (
        await list(
          request(
            `?period=2026-09&${new URLSearchParams(Object.entries(range))}`,
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await calculate(
          request("/calculate", {
            ...calculateInput,
            period: "2026-09",
            ...range,
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await statement(
          request("/statement", {
            ...statementInput,
            period: "2026-09",
            ...range,
          }),
        )
      ).status,
    ).toBe(400);
    for (const operation of Object.values(service))
      expect(operation).not.toHaveBeenCalled();
  });
  it.each([null, "", "-1", "NaN", "Infinity", "1.001", 100])(
    "rejects invalid salary amount %s",
    async (amount) => {
      const response = await settings(
        request("/settings", { ...settingsInput, baseSalary: amount }),
      );
      expect(response.status).toBe(400);
      expect(service.saveSalarySettings).not.toHaveBeenCalled();
    },
  );
  it("accepts explicit zero and exact monetary text", async () => {
    expect(
      (
        await settings(
          request("/settings", {
            ...settingsInput,
            baseSalary: "0",
            overtimeHourlyRate: "0.00",
          }),
        )
      ).status,
    ).toBe(200);
    expect(service.saveSalarySettings).toHaveBeenCalledWith(
      expect.objectContaining({ id: "actor" }),
      "employee1",
      {
        effectiveMonth: "2026-10",
        baseSalary: "0.00",
        overtimeHourlyRate: "0.00",
      },
    );
  });
  it("rejects browser-provided overtime, totals and report content", async () => {
    expect(
      (
        await calculate(
          request("/calculate", {
            ...calculateInput,
            payableOvertimeMinutes: 750,
            totalSalary: "32500",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await statement(
          request("/statement", { ...statementInput, attendance: [] }),
        )
      ).status,
    ).toBe(400);
    expect(service.calculateSalaries).not.toHaveBeenCalled();
    expect(service.salaryStatementForExport).not.toHaveBeenCalled();
  });
  it.each([
    { payableDays: 9 },
    { salaryDivisor: 30 },
    { configuredWeekendDays: [] },
    { baseSalary: "6230.77", monthlyBaseSalary: "18000.00" },
  ])(
    "rejects browser-provided payroll policy or day counts %s",
    async (fields) => {
      const response = await calculate(
        request("/calculate", { ...calculateInput, ...fields }),
      );
      expect(response.status).toBe(400);
      expect(service.calculateSalaries).not.toHaveBeenCalled();
    },
  );
  it("rejects missing, duplicated and excessive employee selections", async () => {
    for (const employeeIds of [
      [],
      ["employee1", "employee1"],
      Array.from({ length: 101 }, (_, i) => `employee${i}`),
    ]) {
      expect(
        (
          await calculate(
            request("/calculate", { ...calculateInput, employeeIds }),
          )
        ).status,
      ).toBe(400);
    }
    expect(service.calculateSalaries).not.toHaveBeenCalled();
  });
  it("returns only authoritative calculated results", async () => {
    vi.mocked(service.calculateSalaries).mockResolvedValue([
      { totalSalary: "32500.00", token: "server-owned" },
    ] as Awaited<ReturnType<typeof service.calculateSalaries>>);
    const response = await calculate(request("/calculate", calculateInput));
    expect(await response.json()).toMatchObject({
      success: true,
      data: { items: [{ totalSalary: "32500.00", token: "server-owned" }] },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("private salary DOCX downloads", () => {
  const data = {
    employee: { employeeCode: 'EMP001\r\n"/private' },
    period: "2026-10",
    from: "2026-10-01",
    to: "2026-10-31",
    totalSalary: "32500.00",
  } as SalaryStatementData;
  it("generates from the validated server preview and sends a safe attachment", async () => {
    vi.mocked(service.salaryStatementForExport).mockResolvedValue(data);
    vi.mocked(salaryStatementDocx).mockResolvedValue(
      Buffer.from("PK fixture docx"),
    );
    const response = await statement(request("/statement", statementInput));
    expect(response.status).toBe(200);
    expect(service.salaryStatementForExport).toHaveBeenCalledWith(
      expect.objectContaining({ id: "actor" }),
      { ...statementInput, from: "2026-10-01", to: "2026-10-31" },
    );
    expect(salaryStatementDocx).toHaveBeenCalledWith(data);
    expect(response.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="salary-statement-EMP001-private-2026-10.docx"',
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("PK fixture docx");
  });
  it("keeps the custom range in the authorized attachment filename", async () => {
    const input = {
      ...statementInput,
      period: "2026-09",
      from: "2026-09-19",
      to: "2026-09-30",
    };
    vi.mocked(service.salaryStatementForExport).mockResolvedValue({
      ...data,
      ...input,
    });
    vi.mocked(salaryStatementDocx).mockResolvedValue(
      Buffer.from("PK fixture docx"),
    );
    const response = await statement(request("/statement", input));
    expect(response.status).toBe(200);
    expect(service.salaryStatementForExport).toHaveBeenCalledWith(
      expect.objectContaining({ id: "actor" }),
      input,
    );
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="salary-statement-EMP001-private-2026-09-19-to-2026-09-30.docx"',
    );
  });
  it.each(["SALARY_SOURCE_CHANGED", "SALARY_CALCULATION_EXPIRED"])(
    "requires recalculation for %s",
    async (code) => {
      vi.mocked(service.salaryStatementForExport).mockRejectedValue(
        new DomainError(code, "Recalculate before downloading", 409),
      );
      const response = await statement(request("/statement", statementInput));
      expect(response.status).toBe(409);
      expect(salaryStatementDocx).not.toHaveBeenCalled();
    },
  );
  it.each([Buffer.alloc(0), Buffer.from("invalid")])(
    "rejects empty or malformed generated files",
    async (bytes) => {
      vi.mocked(service.salaryStatementForExport).mockResolvedValue(data);
      vi.mocked(salaryStatementDocx).mockResolvedValue(bytes);
      const response = await statement(request("/statement", statementInput));
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        error: { code: "SALARY_DOCUMENT_FAILED" },
      });
      expect(response.headers.get("content-disposition")).toBeNull();
    },
  );
  it("returns an actionable generation error without leaking report content", async () => {
    vi.mocked(service.salaryStatementForExport).mockResolvedValue(data);
    vi.mocked(salaryStatementDocx).mockRejectedValue(
      new Error("private employee data"),
    );
    const response = await statement(request("/statement", statementInput));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private employee data");
  });
});
