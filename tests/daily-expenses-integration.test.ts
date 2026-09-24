import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Only the connection is replaced: every service, query, constraint, transaction,
// and audit write below runs against PostgreSQL with the real Prisma adapter.
const isolated = vi.hoisted(() => ({
  client: undefined as PrismaClient | undefined,
}));
vi.mock("@/lib/db", () => ({
  db: new Proxy(
    {},
    {
      get(_target, key) {
        if (!isolated.client)
          throw new Error("The isolated test database is not ready");
        const value = Reflect.get(isolated.client, key);
        return typeof value === "function"
          ? value.bind(isolated.client)
          : value;
      },
    },
  ),
}));

import {
  addDailyExpense,
  addDailyExpenseBalance,
  createDailyExpenseCategory,
  getDailyExpensesSummary,
  listDailyExpenseCategories,
  listDailyExpenseTransactions,
  updateDailyExpenseCategory,
} from "@/modules/daily-expenses/service";

const testDatabase = process.env.TEST_DATABASE_URL;
const integration = testDatabase ? describe : describe.skip;
const schema = `daily_expenses_test_${randomUUID().replaceAll("-", "")}`;
const date = "2024-01-01";
let db: PrismaClient;
let admin: { id: string; role: "ADMIN"; status: "ACTIVE" };
let control: Client;

const input = (amount = "1.00", extra: Record<string, unknown> = {}) => ({
  amount,
  date,
  idempotencyKey: randomUUID(),
  ...extra,
});
const balance = (amount: string, extra: Record<string, unknown> = {}) =>
  addDailyExpenseBalance(admin, input(amount, extra));
const category = (name = "Supplies") =>
  createDailyExpenseCategory(admin, { name });
const history = (query: Record<string, unknown> = {}) =>
  listDailyExpenseTransactions(admin, { page: 1, pageSize: 25, ...query });
const expectTotals = async (
  currentBalance: string,
  totalBalanceAdded: string,
  totalExpenses?: string,
) => {
  expect(await getDailyExpensesSummary(admin)).toMatchObject({
    currentBalance,
    totalBalanceAdded,
    ...(totalExpenses === undefined ? {} : { totalExpenses }),
  });
};

integration(
  "Daily Expenses with isolated PostgreSQL constraints and concurrency",
  () => {
    beforeAll(async () => {
      if (!testDatabase || !new URL(testDatabase).pathname.includes("test"))
        throw new Error(
          "TEST_DATABASE_URL must identify an isolated database with 'test' in its name",
        );
      control = new Client({ connectionString: testDatabase });
      await control.connect();
      await control.query(`CREATE SCHEMA "${schema}"`);
      await control.query(`SET search_path TO "${schema}"`);
      const directory = path.join(process.cwd(), "prisma/migrations");
      for (const migration of (await readdir(directory)).sort()) {
        if (migration === "migration_lock.toml") continue;
        const sql = await readFile(
          path.join(directory, migration, "migration.sql"),
          "utf8",
        );
        await control.query(
          sql.replace('CREATE SCHEMA IF NOT EXISTS "public";', ""),
        );
      }
      db = new PrismaClient({
        adapter: new PrismaPg(
          {
            connectionString: testDatabase,
            options: `-c search_path=${schema}`,
            application_name: schema,
            max: 15,
          },
          { schema },
        ),
      });
      isolated.client = db;
      vi.stubEnv("DAILY_EXPENSES_CURRENCY", "BDT");
      vi.stubEnv("DAILY_EXPENSES_TIMEZONE", "Asia/Dhaka");
    }, 60_000);

    beforeEach(async () => {
      vi.stubEnv("DAILY_EXPENSES_CURRENCY", "BDT");
      vi.stubEnv("DAILY_EXPENSES_TIMEZONE", "Asia/Dhaka");
      // The random schema exists only in the explicitly supplied test database.
      // TRUNCATE avoids weakening the production immutable-entry triggers.
      await control.query(
        'TRUNCATE "DailyExpenseTransaction", "DailyExpenseCategory", "DailyExpenseLedger", "AuditLog"',
      );
      const user = await db.user.create({
        data: {
          email: `daily-${randomUUID()}@example.test`,
          name: "Ledger administrator",
          role: "ADMIN",
        },
      });
      admin = { id: user.id, role: "ADMIN", status: "ACTIVE" };
    });

    afterAll(async () => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      await db?.$disconnect();
      if (control) {
        await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await control.end();
      }
    });

    it("implements the required all-time sequence including overspending", async () => {
      expect(
        await db.employee.findUnique({ where: { userId: admin.id } }),
      ).toBeNull();
      await expectTotals("0.00", "0.00", "0.00");
      const supplies = await category();
      await balance("1000.00");
      await expectTotals("1000.00", "1000.00", "0.00");
      await addDailyExpense(
        admin,
        input("250.00", { categoryId: supplies.id }),
      );
      await expectTotals("750.00", "1000.00", "250.00");
      await addDailyExpense(
        admin,
        input("900.00", { categoryId: supplies.id }),
      );
      await expectTotals("-150.00", "1000.00", "1150.00");
      await balance("500.00");
      await expectTotals("350.00", "1500.00", "1150.00");
    });

    it.each(["+06:00", "-04:00", "Not/AZone"])(
      "rejects invalid or ambiguous configured timezone %s before creating a ledger",
      async (timezone) => {
        vi.stubEnv("DAILY_EXPENSES_TIMEZONE", timezone);
        await expect(getDailyExpensesSummary(admin)).rejects.toMatchObject({
          code: "DAILY_EXPENSES_CONFIGURATION",
          status: 500,
        });
        expect(await db.dailyExpenseLedger.count()).toBe(0);
      },
    );

    it("preserves persisted currency and timezone when environment configuration changes", async () => {
      const initial = await getDailyExpensesSummary(admin);
      expect(initial.ledger).toMatchObject({
        currency: "BDT",
        timezone: "Asia/Dhaka",
      });
      await balance("1.00");
      vi.stubEnv("DAILY_EXPENSES_CURRENCY", "EUR");
      vi.stubEnv("DAILY_EXPENSES_TIMEZONE", "UTC");
      expect((await getDailyExpensesSummary(admin)).ledger).toEqual(
        initial.ledger,
      );
      vi.stubEnv("DAILY_EXPENSES_CURRENCY", "INVALID");
      vi.stubEnv("DAILY_EXPENSES_TIMEZONE", "+06:00");
      await expect(balance("1.00")).resolves.toHaveProperty("transaction");
      expect((await getDailyExpensesSummary(admin)).ledger).toEqual(
        initial.ledger,
      );
      await expectTotals("2.00", "2.00", "0.00");
      expect(await db.dailyExpenseLedger.count()).toBe(1);
    });

    it("allows an expense as the first entry and exact fractional arithmetic", async () => {
      const supplies = await category();
      await addDailyExpense(admin, input("0.30", { categoryId: supplies.id }));
      await expectTotals("-0.30", "0.00", "0.30");
      await balance("0.10");
      await balance("0.20");
      await expectTotals("0.00", "0.30", "0.30");
    });

    it("rejects invalid financial input before posting or auditing it", async () => {
      for (const amount of [
        "0",
        "-1",
        "NaN",
        "Infinity",
        "1e3",
        "1.001",
        "10000000000000000",
        "no",
        "",
      ]) {
        await expect(balance(amount)).rejects.toBeDefined();
      }
      expect(await db.dailyExpenseTransaction.count()).toBe(0);
      expect(await db.auditLog.count({ where: { actorId: admin.id } })).toBe(0);
    });

    it("deduplicates concurrent normalized retries and records exactly one audit", async () => {
      const submission = input("5.00", { note: "Deposit" });
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          addDailyExpenseBalance(admin, submission),
        ),
      );
      expect(new Set(results.map((result) => result.transaction.id)).size).toBe(
        1,
      );
      expect(results.filter((result) => !result.replayed)).toHaveLength(1);
      expect(await db.dailyExpenseTransaction.count()).toBe(1);
      const id = results[0].transaction.id;
      expect(await db.auditLog.count({ where: { resourceId: id } })).toBe(1);
      const replay = await addDailyExpenseBalance(admin, {
        ...submission,
        amount: "5",
        note: " Deposit ",
      });
      expect(replay).toMatchObject({ replayed: true, transaction: { id } });
      await expectTotals("5.00", "5.00", "0.00");
    });

    it("rejects reused keys with changed payloads or actors and reauthorizes retries", async () => {
      const submission = input("5.00");
      await addDailyExpenseBalance(admin, submission);
      for (const change of [
        { amount: "6.00" },
        { date: "2024-01-02" },
        { note: "changed" },
      ])
        await expect(
          addDailyExpenseBalance(admin, { ...submission, ...change }),
        ).rejects.toMatchObject({ status: 409 });
      const other = await db.user.create({
        data: { email: `other-${randomUUID()}@example.test`, role: "ADMIN" },
      });
      await expect(
        addDailyExpenseBalance(
          { id: other.id, role: "ADMIN", status: "ACTIVE" },
          submission,
        ),
      ).rejects.toMatchObject({ status: 409 });
      for (const role of ["EMPLOYEE", "MANAGE_DRIVER"])
        await expect(
          addDailyExpenseBalance({ ...admin, role }, submission),
        ).rejects.toMatchObject({ status: 403 });
      await expectTotals("5.00", "5.00", "0.00");
      expect(await db.dailyExpenseTransaction.count()).toBe(1);
    });

    it("handles simultaneous different submissions sharing a key as one success and one conflict", async () => {
      const submission = input("5.00");
      const results = await Promise.allSettled([
        addDailyExpenseBalance(admin, submission),
        addDailyExpenseBalance(admin, { ...submission, amount: "7.00" }),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const failure = results.find((result) => result.status === "rejected");
      expect(failure).toMatchObject({ reason: { status: 409 } });
      expect(await db.dailyExpenseTransaction.count()).toBe(1);
    });

    it("aggregates legitimate concurrent entries consistently without lost writes", async () => {
      const supplies = await category();
      await Promise.all([
        ...Array.from({ length: 12 }, () => balance("10.01")),
        ...Array.from({ length: 10 }, () =>
          addDailyExpense(admin, input("15.03", { categoryId: supplies.id })),
        ),
      ]);
      await expectTotals("-30.18", "120.12", "150.30");
      expect(await db.dailyExpenseTransaction.count()).toBe(22);
      const transactions = await db.dailyExpenseTransaction.findMany({
        select: { id: true },
      });
      expect(
        await db.auditLog.count({
          where: { resourceId: { in: transactions.map(({ id }) => id) } },
        }),
      ).toBe(22);
    });

    it("retains cents when all-time totals exceed Decimal's default arithmetic precision", async () => {
      const { ledger } = await getDailyExpensesSummary(admin);
      const supplies = await category();
      await db.dailyExpenseTransaction.createMany({
        data: Array.from({ length: 1001 }, () => ({
          ledgerId: ledger.id,
          type: "BALANCE_ADDED" as const,
          amount: "9999999999999999.99",
          date: new Date(`${date}T00:00:00Z`),
          createdById: admin.id,
          idempotencyKey: randomUUID(),
          payloadHash: "a".repeat(64),
        })),
      });
      await addDailyExpense(admin, input("0.01", { categoryId: supplies.id }));
      await expectTotals(
        "10009999999999999989.98",
        "10009999999999999989.99",
        "0.01",
      );
    });

    it("rejects an expense that waits behind a concurrent category archive", async () => {
      const supplies = await category();
      await control.query("BEGIN");
      await control.query(
        'UPDATE "DailyExpenseCategory" SET "archived" = true WHERE "id" = $1',
        [supplies.id],
      );
      // Capture rejection immediately to avoid an unhandled promise while the
      // real transaction is blocked by the uncommitted archive row lock.
      const pending = addDailyExpense(
        admin,
        input("2.00", { categoryId: supplies.id }),
      ).then(
        (value) => ({ status: "fulfilled", value }),
        (reason: unknown) => ({ status: "rejected", reason }),
      );
      try {
        await vi.waitFor(async () => {
          const waiting = await control.query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
            [schema],
          );
          expect(waiting.rows[0].count).toBeGreaterThan(0);
        });
        await control.query("COMMIT");
      } catch (error) {
        await control.query("ROLLBACK");
        await pending;
        throw error;
      }
      expect(await pending).toMatchObject({
        status: "rejected",
        reason: { code: "INVALID_CATEGORY" },
      });
      expect(await db.dailyExpenseTransaction.count()).toBe(0);
    });

    it("rolls back financial entries and category changes when their required audit fails", async () => {
      await getDailyExpensesSummary(admin);
      const supplies = await category();
      await control.query(
        `CREATE FUNCTION fail_daily_expense_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected audit failure'; END; $$`,
      );
      await control.query(
        'CREATE TRIGGER fail_daily_expense_test_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION fail_daily_expense_test_audit()',
      );
      try {
        await expect(balance("10.00")).rejects.toBeDefined();
        await expect(
          createDailyExpenseCategory(admin, { name: "Should roll back" }),
        ).rejects.toBeDefined();
        await expect(
          updateDailyExpenseCategory(admin, supplies.id, {
            name: "Should also roll back",
          }),
        ).rejects.toBeDefined();
        expect(await db.dailyExpenseTransaction.count()).toBe(0);
        expect(
          (await listDailyExpenseCategories(admin)).map((item) => item.name),
        ).toEqual(["Supplies"]);
      } finally {
        await control.query(
          'DROP TRIGGER fail_daily_expense_test_audit ON "AuditLog"',
        );
        await control.query("DROP FUNCTION fail_daily_expense_test_audit()");
      }
    });

    it("enforces category uniqueness under concurrency and across rename/archive/restore", async () => {
      const results = await Promise.allSettled([
        category(" Travel "),
        category("travel"),
        category("TRAVEL"),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(await db.dailyExpenseCategory.count()).toBe(1);
      const [travel] = await listDailyExpenseCategories(admin);
      await updateDailyExpenseCategory(admin, travel.id, { archived: true });
      await expect(category("TrAvEl")).rejects.toMatchObject({ status: 409 });
      const supplies = await category("Supplies");
      await expect(
        updateDailyExpenseCategory(admin, supplies.id, { name: "TRAVEL" }),
      ).rejects.toMatchObject({ status: 409 });
      await updateDailyExpenseCategory(admin, travel.id, {
        archived: false,
        name: "Transport",
      });
      expect(await listDailyExpenseCategories(admin)).toContainEqual(
        expect.objectContaining({
          id: travel.id,
          name: "Transport",
          archived: false,
        }),
      );
    });

    it.each([
      ["café", "CAFÉ", "CaFé"],
      ["Straße", "STRAẞE", "straße"],
    ])(
      "enforces Unicode case-insensitive category uniqueness under concurrent creates: %s",
      async (...names) => {
        const results = await Promise.allSettled(
          names.map((name) => category(name)),
        );
        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
          results.filter((result) => result.status === "rejected"),
        ).toHaveLength(2);
        for (const result of results)
          if (result.status === "rejected")
            expect(result.reason).toMatchObject({
              code: "CATEGORY_CONFLICT",
              status: 409,
            });
        expect(await db.dailyExpenseCategory.count()).toBe(1);
      },
    );

    it("accepts maximum-length category names whose Unicode lowercase representation expands", async () => {
      const name = "İ".repeat(80);
      const created = await category(name);
      expect(created.name).toBe(name);
      const stored = await db.dailyExpenseCategory.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(stored.normalizedName).toBe("i\u0307".repeat(80));
      expect(stored.normalizedName.length).toBe(160);
      await expect(category(name)).rejects.toMatchObject({
        code: "CATEGORY_CONFLICT",
        status: 409,
      });
      expect(await db.dailyExpenseCategory.count()).toBe(1);
    });

    it("requires a category, disallows archived categories, and preserves historical categories", async () => {
      await expect(addDailyExpense(admin, input())).rejects.toBeDefined();
      await expect(
        addDailyExpense(admin, input("1.00", { categoryId: "missing" })),
      ).rejects.toBeDefined();
      const travel = await category("Travel");
      const submission = input("12.00", { categoryId: travel.id });
      const posted = await addDailyExpense(admin, submission);
      await updateDailyExpenseCategory(admin, travel.id, { archived: true });
      await expect(
        addDailyExpense(admin, input("1.00", { categoryId: travel.id })),
      ).rejects.toBeDefined();
      expect((await history({ categoryId: travel.id })).items).toContainEqual(
        expect.objectContaining({
          id: posted.transaction.id,
          category: expect.objectContaining({ id: travel.id, archived: true }),
        }),
      );
      expect(await addDailyExpense(admin, submission)).toMatchObject({
        replayed: true,
        transaction: { id: posted.transaction.id },
      });
      await updateDailyExpenseCategory(admin, travel.id, {
        name: "Transport",
        archived: false,
      });
      expect((await history()).items[0].category?.name).toBe("Transport");
      await addDailyExpense(admin, input("1.00", { categoryId: travel.id }));
      expect(await db.dailyExpenseTransaction.count()).toBe(2);
    });

    it("enforces ledger scope in services and the database composite foreign key", async () => {
      const summary = await getDailyExpensesSummary(admin);
      const otherLedger = await db.dailyExpenseLedger.create({
        data: {
          workspaceKey: `other-${randomUUID()}`,
          currency: "BDT",
          timezone: "Asia/Dhaka",
        },
      });
      const foreignCategory = await db.dailyExpenseCategory.create({
        data: { ledgerId: otherLedger.id, name: "Private category" },
      });
      await expect(
        addDailyExpense(
          admin,
          input("1.00", { categoryId: foreignCategory.id }),
        ),
      ).rejects.toBeDefined();
      await expect(
        updateDailyExpenseCategory(admin, foreignCategory.id, {
          archived: true,
        }),
      ).rejects.toBeDefined();
      await expect(
        history({ categoryId: foreignCategory.id }),
      ).rejects.toBeDefined();
      expect(await listDailyExpenseCategories(admin)).toEqual([]);
      await expect(
        db.dailyExpenseTransaction.create({
          data: {
            ledgerId: summary.ledger.id,
            type: "EXPENSE",
            amount: "1.00",
            categoryId: foreignCategory.id,
            date: new Date(`${date}T00:00:00Z`),
            createdById: admin.id,
            idempotencyKey: randomUUID(),
            payloadHash: "a".repeat(64),
          },
        }),
      ).rejects.toBeDefined();
      await db.dailyExpenseTransaction.create({
        data: {
          ledgerId: otherLedger.id,
          type: "BALANCE_ADDED",
          amount: "500.00",
          date: new Date(`${date}T00:00:00Z`),
          createdById: admin.id,
          idempotencyKey: randomUUID(),
          payloadHash: "a".repeat(64),
        },
      });
      await expectTotals("0.00", "0.00", "0.00");
      expect((await history()).total).toBe(0);
    });

    it("enforces finite positive amounts, category shape, future dates and active categories in PostgreSQL", async () => {
      const { ledger } = await getDailyExpensesSummary(admin);
      const supplies = await category();
      const direct = (overrides: Record<string, unknown>) =>
        db.dailyExpenseTransaction.create({
          data: {
            ledgerId: ledger.id,
            type: "BALANCE_ADDED",
            amount: "1.00",
            date: new Date(`${date}T00:00:00Z`),
            createdById: admin.id,
            idempotencyKey: randomUUID(),
            payloadHash: "a".repeat(64),
            ...overrides,
          },
        });
      for (const amount of [
        "0",
        "-1",
        "NaN",
        "Infinity",
        "10000000000000000.00",
      ])
        await expect(direct({ amount })).rejects.toBeDefined();
      await expect(direct({ type: "EXPENSE" })).rejects.toBeDefined();
      await expect(direct({ categoryId: supplies.id })).rejects.toBeDefined();
      await expect(
        direct({ date: new Date("9999-01-01T00:00:00Z") }),
      ).rejects.toBeDefined();
      await updateDailyExpenseCategory(admin, supplies.id, { archived: true });
      await expect(
        direct({ type: "EXPENSE", categoryId: supplies.id }),
      ).rejects.toBeDefined();
      expect(await db.dailyExpenseTransaction.count()).toBe(0);
    });

    it("prevents rewriting/deleting posted entries, changing ledger configuration, or deleting their authors", async () => {
      const posted = await balance("12.50");
      const { ledger } = await getDailyExpensesSummary(admin);
      await expect(
        db.dailyExpenseTransaction.update({
          where: { id: posted.transaction.id },
          data: { amount: "999.00" },
        }),
      ).rejects.toBeDefined();
      await expect(
        db.dailyExpenseTransaction.delete({
          where: { id: posted.transaction.id },
        }),
      ).rejects.toBeDefined();
      await expect(
        db.dailyExpenseLedger.update({
          where: { id: ledger.id },
          data: { currency: "EUR" },
        }),
      ).rejects.toBeDefined();
      await expect(
        db.dailyExpenseLedger.update({
          where: { id: ledger.id },
          data: { timezone: "UTC" },
        }),
      ).rejects.toBeDefined();
      await expect(
        db.user.delete({ where: { id: admin.id } }),
      ).rejects.toBeDefined();
      await expectTotals("12.50", "12.50", "0.00");
      expect((await history()).items[0].createdBy.id).toBe(admin.id);
    });

    it("does not change unrelated business records or attendance event tables", async () => {
      const trip = await db.driveCost.create({
        data: {
          date: new Date(`${date}T00:00:00Z`),
          destinationFrom: "Office",
          destinationTo: "Warehouse",
          kilometers: "10.00",
          rateType: "IN_TIME",
          ratePerKilometer: "5.00",
          totalCost: "50.00",
          createdById: admin.id,
        },
      });
      const setting = await db.systemSetting.create({
        data: { key: `daily-test-${randomUUID()}`, value: { unrelated: true } },
      });
      const counts = async () =>
        Promise.all([
          db.attendance.count(),
          db.attendanceEvent.count(),
          db.leave.count(),
          db.employee.count(),
          db.driveCost.count(),
          db.systemSetting.count(),
        ]);
      const before = await counts();
      const supplies = await category();
      await balance("100.00");
      await addDailyExpense(admin, input("25.00", { categoryId: supplies.id }));
      await updateDailyExpenseCategory(admin, supplies.id, {
        name: "Equipment",
        archived: true,
      });
      await history();
      await expectTotals("75.00", "100.00", "25.00");
      expect(await counts()).toEqual(before);
      expect(await db.driveCost.findUnique({ where: { id: trip.id } })).toEqual(
        trip,
      );
      expect(
        await db.systemSetting.findUnique({ where: { key: setting.key } }),
      ).toEqual(setting);
    });

    it("keeps all-time totals independent of history filters and deterministic pagination", async () => {
      const supplies = await category();
      await balance("100.00", { note: "Opening funds", date: "2024-01-01" });
      const first = await addDailyExpense(
        admin,
        input("20.00", {
          note: "Paper",
          categoryId: supplies.id,
          date: "2024-01-02",
        }),
      );
      const second = await addDailyExpense(
        admin,
        input("30.00", {
          note: "Printer paper",
          categoryId: supplies.id,
          date: "2024-01-02",
        }),
      );
      const filtered = await history({
        from: "2024-01-02",
        to: "2024-01-02",
        type: "EXPENSE",
        categoryId: supplies.id,
        search: "PAPER",
        pageSize: 1,
      });
      expect(filtered).toMatchObject({
        total: 2,
        page: 1,
        pageSize: 1,
        totalPages: 2,
      });
      const next = await history({
        from: "2024-01-02",
        to: "2024-01-02",
        type: "EXPENSE",
        categoryId: supplies.id,
        search: "PAPER",
        pageSize: 1,
        page: 2,
      });
      expect(
        new Set([...filtered.items, ...next.items].map(({ id }) => id)),
      ).toEqual(new Set([first.transaction.id, second.transaction.id]));
      expect((await history({ from: "2024-02-01" })).items).toEqual([]);
      expect((await history({ type: "BALANCE_ADDED" })).total).toBe(1);
      await expectTotals("50.00", "100.00", "50.00");
      expect((await history({ pageSize: 1 })).items).toEqual(
        (await history({ pageSize: 1 })).items,
      );
    });

    it("validates business dates against the ledger timezone while preserving recording timestamps", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2024-01-01T17:59:59Z"));
        expect((await getDailyExpensesSummary(admin)).today).toBe("2024-01-01");
        await expect(
          balance("1.00", { date: "2024-01-02" }),
        ).rejects.toBeDefined();
        vi.setSystemTime(new Date("2024-01-01T18:00:00Z"));
        expect((await getDailyExpensesSummary(admin)).today).toBe("2024-01-02");
        const posted = await balance("1.00", { date: "2024-01-02" });
        expect(
          (await history({ from: "2024-01-02", to: "2024-01-02" })).items[0].id,
        ).toBe(posted.transaction.id);
        expect(posted.transaction.date).toBe("2024-01-02");
        expect(posted.transaction.createdAt).toBe("2024-01-01T18:00:00.000Z");
        const backdated = await balance("1.00", { date: "2023-12-01" });
        expect(backdated.transaction.date).toBe("2023-12-01");
        expect(backdated.transaction.createdAt).toBe(
          "2024-01-01T18:00:00.000Z",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("blocks unauthorized direct service entry points before accessing ledger data", async () => {
      for (const actor of [
        { ...admin, role: "EMPLOYEE" },
        { ...admin, role: "MANAGE_DRIVER" },
        { ...admin, status: "SUSPENDED" },
      ]) {
        const operations = [
          () => getDailyExpensesSummary(actor),
          () => listDailyExpenseTransactions(actor, {}),
          () => listDailyExpenseCategories(actor),
          () => addDailyExpenseBalance(actor, input()),
          () => addDailyExpense(actor, input()),
          () => createDailyExpenseCategory(actor, { name: "Blocked" }),
          () =>
            updateDailyExpenseCategory(actor, "missing", { archived: true }),
        ];
        for (const operation of operations)
          await expect(operation()).rejects.toMatchObject({ status: 403 });
      }
      expect(await db.dailyExpenseLedger.count()).toBe(0);
      expect(await db.auditLog.count()).toBe(0);
      await expect(
        getDailyExpensesSummary({ ...admin, role: "SUPER_ADMIN" }),
      ).resolves.toMatchObject({ currentBalance: "0.00" });
    });
  },
);
