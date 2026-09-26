import { describe, expect, it } from "vitest";
import {
  amountSchema,
  balanceInputSchema,
  businessDateSchema,
  categoryCreateSchema,
  categoryUpdateSchema,
  expenseInputSchema,
  formatMoney,
  historyQuerySchema,
  todayInTimezone,
  transactionUpdateSchema,
  transactionDeleteSchema,
  dailyExpenseReportQuerySchema,
} from "@/modules/daily-expenses/contracts";
import {
  authorizeDailyExpenses,
  canManageDailyExpenses,
  authorizeDailyExpenseWrite,
  canWriteDailyExpenses,
  authorizeDailyExpenseTransactionEdit,
  canEditDailyExpenseTransactions,
  authorizeDailyExpenseTransactionDelete,
  canDeleteDailyExpenseTransactions,
  canDownloadDailyExpenseReport,
  authorizeDailyExpenseReport,
} from "@/modules/daily-expenses/permissions";

describe("Daily Expenses client-safe validation", () => {
  it("reserves all writes for active super admins while admins retain read access", () => {
    expect(canWriteDailyExpenses("SUPER_ADMIN")).toBe(true);
    expect(() =>
      authorizeDailyExpenseWrite({
        id: "super",
        role: "SUPER_ADMIN",
        status: "ACTIVE",
      }),
    ).not.toThrow();
    for (const role of ["ADMIN", "EMPLOYEE", "MANAGE_DRIVER", "unknown"]) {
      expect(canWriteDailyExpenses(role)).toBe(false);
      expect(() =>
        authorizeDailyExpenseWrite({ id: "user", role, status: "ACTIVE" }),
      ).toThrow();
    }
    for (const actor of [
      { id: "super", role: "SUPER_ADMIN", status: "INACTIVE" },
      { id: "super", role: "SUPER_ADMIN", status: "SUSPENDED" },
      { id: "", role: "SUPER_ADMIN", status: "ACTIVE" },
    ]) {
      expect(() => authorizeDailyExpenseWrite(actor)).toThrow();
    }
    expect(() =>
      authorizeDailyExpenses({ id: "admin", role: "ADMIN", status: "ACTIVE" }),
    ).not.toThrow();
  });

  it("allows only active super admins to download daily expense reports", () => {
    expect(canDownloadDailyExpenseReport("SUPER_ADMIN")).toBe(true);
    expect(() =>
      authorizeDailyExpenseReport({
        id: "super",
        role: "SUPER_ADMIN",
        status: "ACTIVE",
      }),
    ).not.toThrow();
    for (const role of ["ADMIN", "EMPLOYEE", "MANAGE_DRIVER", "unknown"]) {
      expect(canDownloadDailyExpenseReport(role)).toBe(false);
      expect(() => authorizeDailyExpenseReport({ id: "user", role })).toThrow();
    }
    expect(() =>
      authorizeDailyExpenseReport({
        id: "super",
        role: "SUPER_ADMIN",
        status: "INACTIVE",
      }),
    ).toThrow();
  });

  it("validates report filters and ignores list pagination without accepting caller scope", () => {
    expect(
      dailyExpenseReportQuerySchema.parse({
        from: "2024-01-01",
        to: "2024-01-31",
        type: "EXPENSE",
        categoryId: "supplies",
        search: "  paper  ",
        page: "2",
        pageSize: "1",
      }),
    ).toEqual({
      from: "2024-01-01",
      to: "2024-01-31",
      type: "EXPENSE",
      categoryId: "supplies",
      search: "paper",
    });
    for (const filters of [
      { from: "2024-02-30" },
      { from: "2024-02-01", to: "2024-01-01" },
      { type: "OTHER" },
      { search: "x".repeat(201) },
      { ledgerId: "foreign" },
      { deletedAt: null },
      { createdById: "forged" },
    ])
      expect(dailyExpenseReportQuerySchema.safeParse(filters).success).toBe(
        false,
      );
  });
  it("reserves deletion for active super admins and requires the reviewed version", () => {
    expect(canDeleteDailyExpenseTransactions("SUPER_ADMIN")).toBe(true);
    expect(() =>
      authorizeDailyExpenseTransactionDelete({
        id: "super",
        role: "SUPER_ADMIN",
        status: "ACTIVE",
      }),
    ).not.toThrow();
    for (const role of ["ADMIN", "EMPLOYEE", "MANAGE_DRIVER", "unknown"]) {
      expect(canDeleteDailyExpenseTransactions(role)).toBe(false);
      expect(() =>
        authorizeDailyExpenseTransactionDelete({ id: "user", role }),
      ).toThrow();
    }
    expect(() =>
      authorizeDailyExpenseTransactionDelete({
        id: "super",
        role: "SUPER_ADMIN",
        status: "INACTIVE",
      }),
    ).toThrow();
    expect(transactionDeleteSchema.parse({ expectedVersion: 1 })).toEqual({
      expectedVersion: 1,
    });
    for (const expectedVersion of [undefined, 0, -1, 1.5, "1", 2147483647]) {
      expect(
        transactionDeleteSchema.safeParse({ expectedVersion }).success,
      ).toBe(false);
    }
    for (const field of ["deletedAt", "amount", "ledgerId", "actorId"]) {
      expect(
        transactionDeleteSchema.safeParse({
          expectedVersion: 1,
          [field]: "forged",
        }).success,
      ).toBe(false);
    }
  });
  it("reserves transaction edits for active super admins", () => {
    expect(canEditDailyExpenseTransactions("SUPER_ADMIN")).toBe(true);
    expect(() =>
      authorizeDailyExpenseTransactionEdit({
        id: "super",
        role: "SUPER_ADMIN",
        status: "ACTIVE",
      }),
    ).not.toThrow();
    for (const role of ["ADMIN", "EMPLOYEE", "MANAGE_DRIVER", "unknown"]) {
      expect(canEditDailyExpenseTransactions(role)).toBe(false);
      expect(() =>
        authorizeDailyExpenseTransactionEdit({ id: "user", role }),
      ).toThrow();
    }
    expect(() =>
      authorizeDailyExpenseTransactionEdit({
        id: "super",
        role: "SUPER_ADMIN",
        status: "INACTIVE",
      }),
    ).toThrow();
    expect(() =>
      authorizeDailyExpenseTransactionEdit({ id: "", role: "SUPER_ADMIN" }),
    ).toThrow();
  });

  it("requires a valid version and rejects changes to transaction identity", () => {
    const edit = {
      amount: "001.2",
      date: "2024-01-01",
      note: "  corrected  ",
      expectedVersion: 1,
    };
    expect(transactionUpdateSchema.parse(edit)).toMatchObject({
      amount: "1.20",
      note: "corrected",
      expectedVersion: 1,
    });
    for (const expectedVersion of [undefined, 0, -1, 1.5, "1", 2147483647]) {
      expect(
        transactionUpdateSchema.safeParse({ ...edit, expectedVersion }).success,
      ).toBe(false);
    }
    for (const field of [
      "id",
      "type",
      "createdById",
      "createdAt",
      "ledgerId",
      "idempotencyKey",
      "payloadHash",
      "role",
    ]) {
      expect(
        transactionUpdateSchema.safeParse({ ...edit, [field]: "forged" })
          .success,
      ).toBe(false);
    }
  });
  it("formats negative and large monetary strings without losing cents", () => {
    expect(formatMoney("-150.00", "BDT")).toBe("-BDT 150.00");
    expect(formatMoney("10009999999999999989.98", "BDT")).toBe(
      "BDT 10,009,999,999,999,999,989.98",
    );
  });

  it("centralizes administration access without requiring an Employee profile", () => {
    for (const role of ["ADMIN", "SUPER_ADMIN"]) {
      expect(canManageDailyExpenses(role)).toBe(true);
      expect(() =>
        authorizeDailyExpenses({ id: "user", role, status: "ACTIVE" }),
      ).not.toThrow();
    }
    for (const role of ["EMPLOYEE", "MANAGE_DRIVER", "unknown"]) {
      expect(canManageDailyExpenses(role)).toBe(false);
      expect(() =>
        authorizeDailyExpenses({ id: "user", role, status: "ACTIVE" }),
      ).toThrow();
    }
    expect(() =>
      authorizeDailyExpenses({ id: "user", role: "ADMIN", status: "INACTIVE" }),
    ).toThrow();
    expect(() => authorizeDailyExpenses({ id: "", role: "ADMIN" })).toThrow();
  });
  it.each(["0.01", "0.10", "1", "1.2", "9999999999999999.99"])(
    "accepts exact decimal strings within Decimal(18,2): %s",
    (amount) => {
      expect(amountSchema.safeParse(amount).success).toBe(true);
    },
  );

  it.each([
    "0",
    "0.00",
    "-1",
    "-0.01",
    "NaN",
    "Infinity",
    "-Infinity",
    "1e3",
    "1,000.00",
    "1.001",
    "0.001",
    "10000000000000000",
    "9999999999999999.999",
    "",
    " ",
    "1.2.3",
    "abc",
    1,
    0.1,
    null,
  ])("rejects invalid amounts without coercion or rounding: %j", (amount) => {
    expect(amountSchema.safeParse(amount).success).toBe(false);
  });

  it("requires business dates and submission keys and rejects client identity/scope fields", () => {
    const input = {
      amount: "100.00",
      date: "2026-01-01",
      idempotencyKey: "aee99982-0000-4000-8000-000000000001",
    };
    expect(balanceInputSchema.safeParse(input).success).toBe(true);
    expect(
      balanceInputSchema.safeParse({ ...input, date: undefined }).success,
    ).toBe(false);
    expect(
      balanceInputSchema.safeParse({ ...input, idempotencyKey: undefined })
        .success,
    ).toBe(false);
    for (const field of ["creatorId", "createdById", "role", "ledgerId"])
      expect(
        balanceInputSchema.safeParse({ ...input, [field]: "untrusted" })
          .success,
      ).toBe(false);
    expect(expenseInputSchema.safeParse(input).success).toBe(false);
    expect(
      expenseInputSchema.safeParse({ ...input, categoryId: "category-1" })
        .success,
    ).toBe(true);
  });

  it.each([
    "2026-02-30",
    "2025-02-29",
    "2026-13-01",
    "2026-00-01",
    "2026-1-1",
    "2026-01-01T00:00:00Z",
  ])("rejects invalid calendar date %s", (date) =>
    expect(businessDateSchema.safeParse(date).success).toBe(false),
  );

  it("accepts leap day and uses the configured timezone across midnight", () => {
    expect(businessDateSchema.safeParse("2024-02-29").success).toBe(true);
    expect(
      todayInTimezone("Asia/Dhaka", new Date("2026-09-23T17:59:59Z")),
    ).toBe("2026-09-23");
    expect(
      todayInTimezone("Asia/Dhaka", new Date("2026-09-23T18:00:00Z")),
    ).toBe("2026-09-24");
    expect(
      todayInTimezone("America/New_York", new Date("2026-09-24T03:59:59Z")),
    ).toBe("2026-09-23");
    expect(
      todayInTimezone("America/New_York", new Date("2026-09-24T04:00:00Z")),
    ).toBe("2026-09-24");
  });

  it("bounds names, descriptions, date filters, and server-side pagination", () => {
    expect(
      categoryCreateSchema.parse({ name: "  Office supplies  " }).name,
    ).toBe("Office supplies");
    expect(categoryCreateSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(
      categoryCreateSchema.safeParse({ name: "x".repeat(1000) }).success,
    ).toBe(false);
    expect(categoryUpdateSchema.safeParse({}).success).toBe(false);
    expect(categoryUpdateSchema.safeParse({ archived: true }).success).toBe(
      true,
    );
    expect(
      historyQuerySchema.safeParse({ from: "2026-02-01", to: "2026-01-01" })
        .success,
    ).toBe(false);
    for (const query of [
      { page: 0 },
      { page: -1 },
      { page: 1.5 },
      { pageSize: 0 },
      { pageSize: 10001 },
      { type: "UNKNOWN" },
      { search: "x".repeat(10000) },
    ])
      expect(historyQuerySchema.safeParse(query).success).toBe(false);
    expect(
      balanceInputSchema.safeParse({
        amount: "1",
        date: "2026-01-01",
        idempotencyKey: "aee99982-0000-4000-8000-000000000001",
        note: "x".repeat(10000),
      }).success,
    ).toBe(false);
  });
});
