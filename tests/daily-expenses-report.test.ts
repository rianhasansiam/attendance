import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@/lib/errors";
import type { DailyExpenseReportData } from "@/modules/daily-expenses/contracts";
import type { PdfReport } from "@/modules/reports/pdf";

const mocks = vi.hoisted(() => ({
  data: vi.fn(),
  pdf: vi.fn(),
  user: vi.fn(),
  rateLimit: vi.fn(),
}));
vi.mock("@/modules/daily-expenses/service", () => ({
  getDailyExpenseReportData: mocks.data,
}));
vi.mock("@/modules/reports/pdf", () => ({ createReportPdf: mocks.pdf }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.user }));
vi.mock("@/lib/security", () => ({
  rateLimit: mocks.rateLimit,
  assertSameOrigin: vi.fn(),
}));

import { GET } from "@/app/api/daily-expenses/report/route";
import { createDailyExpenseReportPdf } from "@/modules/daily-expenses/report";

function reportData(): DailyExpenseReportData {
  return {
    ledger: { id: "ledger", currency: "BDT", timezone: "Asia/Dhaka" },
    generatedAt: "2026-09-24T08:00:00.000Z",
    filters: {
      from: "2024-01-01",
      to: "2024-01-31",
      type: "EXPENSE",
      search: "Paper",
    },
    categoryName: null,
    allTime: {
      currentBalance: "80.00",
      totalBalanceAdded: "100.00",
      totalExpenses: "20.00",
    },
    filtered: {
      count: 1,
      totalBalanceAdded: "0.00",
      totalExpenses: "12.30",
      netChange: "-12.30",
    },
    items: [
      {
        id: "transaction-1",
        version: 2,
        type: "EXPENSE",
        amount: "12.30",
        date: "2024-01-01",
        note: "Paper - কাগজ",
        category: {
          id: "supplies",
          name: "Supplies",
          archived: false,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        createdBy: {
          id: "recorder",
          name: "Original recorder",
          email: "recorder@example.test",
        },
        createdAt: "2024-01-01T08:00:00Z",
      },
    ],
  };
}
const request = (query = "") =>
  new Request(
    `https://attendance.example.test/api/daily-expenses/report${query}`,
  );

beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({
    id: "super",
    role: "SUPER_ADMIN",
    status: "ACTIVE",
  });
  mocks.data.mockResolvedValue(reportData());
  mocks.pdf.mockResolvedValue(new TextEncoder().encode("%PDF-1.7\n"));
});

describe("Daily Expenses PDF reports", () => {
  it.each(["ADMIN", "EMPLOYEE", "MANAGE_DRIVER"])(
    "denies %s before fetching or rendering report data",
    async (role) => {
      mocks.user.mockResolvedValue({ id: "user", role, status: "ACTIVE" });
      expect((await GET(request())).status).toBe(403);
      expect(mocks.data).not.toHaveBeenCalled();
      expect(mocks.pdf).not.toHaveBeenCalled();
    },
  );

  it("requires an authenticated session", async () => {
    mocks.user.mockRejectedValue(
      new DomainError("UNAUTHENTICATED", "Sign in", 401),
    );
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.data).not.toHaveBeenCalled();
  });

  it("downloads a private PDF with a safe descriptive filename and request rate limit", async () => {
    const response = await GET(
      request("?from=2024-01-01&to=2024-01-31&search=Paper&page=2&pageSize=1"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="daily-expenses-.*\.pdf"$/,
    );
    expect(await response.text()).toBe("%PDF-1.7\n");
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      expect.stringContaining("super"),
      30,
      60,
    );
    expect(mocks.data).toHaveBeenCalledWith(
      expect.objectContaining({ id: "super", role: "SUPER_ADMIN" }),
      expect.any(Object),
    );
  });

  it("labels global and filtered balances separately and preserves full transaction details", async () => {
    const data = reportData();
    data.items[0].note = "কাগজ Paper ".repeat(80);
    await createDailyExpenseReportPdf(data);
    const pdf = mocks.pdf.mock.calls[0][0] as PdfReport;
    expect(pdf.title.toLowerCase()).toContain("daily expenses");
    expect(pdf.subtitle.join(" ")).toContain("2024-01-01");
    expect(pdf.subtitle.join(" ")).toContain("Asia/Dhaka");
    expect(
      pdf.summary.some(
        (card) => /all.time/i.test(card.label) && card.value.includes("80.00"),
      ),
    ).toBe(true);
    expect(
      pdf.summary.some(
        (card) => /filtered/i.test(card.label) && card.value.includes("12.30"),
      ),
    ).toBe(true);
    expect(pdf.rows).toHaveLength(1);
    expect(pdf.rows[0]).toEqual(
      expect.arrayContaining([
        "2024-01-01",
        "Supplies",
        data.items[0].note,
        expect.stringContaining("Original recorder"),
      ]),
    );
    expect(pdf.rows[0].join(" ")).toContain("12.30");
    expect(pdf.footerNote).toMatch(/deleted/i);
  });

  it("preserves exact large amounts and renders empty filtered reports without inventing transactions", async () => {
    const data = reportData();
    data.allTime.totalBalanceAdded = "99999999999999999990.00";
    data.filtered = {
      count: 0,
      totalBalanceAdded: "0.00",
      totalExpenses: "0.00",
      netChange: "0.00",
    };
    data.items = [];
    await createDailyExpenseReportPdf(data);
    const pdf = mocks.pdf.mock.calls[0][0] as PdfReport;
    expect(pdf.rows).toEqual([]);
    expect(
      pdf.summary.map((card) => card.value.replaceAll(",", "")).join(" "),
    ).toContain("99999999999999999990.00");
  });

  it("returns report errors without downloading a partial PDF", async () => {
    mocks.data.mockRejectedValue(
      new DomainError("REPORT_TOO_LARGE", "Narrow your filters", 400),
    );
    const response = await GET(request());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "REPORT_TOO_LARGE" },
    });
    expect(mocks.pdf).not.toHaveBeenCalled();
  });
});
