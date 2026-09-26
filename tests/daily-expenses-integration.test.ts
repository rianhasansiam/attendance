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
  updateDailyExpenseTransaction,
  deleteDailyExpenseTransaction,
  getDailyExpenseReportData,
} from "@/modules/daily-expenses/service";
import type { DailyExpenseTransactionDTO } from "@/modules/daily-expenses/contracts";

const testDatabase = process.env.TEST_DATABASE_URL;
const integration = testDatabase ? describe : describe.skip;
const schema = `daily_expenses_test_${randomUUID().replaceAll("-", "")}`;
const date = "2024-01-01";
let db: PrismaClient;
let admin: { id: string; role: "ADMIN"; status: "ACTIVE" };
let superAdmin: { id: string; role: "SUPER_ADMIN"; status: "ACTIVE" };
let creator: { id: string; role: "SUPER_ADMIN"; status: "ACTIVE" };
let control: Client;

const input = (amount = "1.00", extra: Record<string, unknown> = {}) => ({
  amount,
  date,
  idempotencyKey: randomUUID(),
  ...extra,
});
const balance = (amount: string, extra: Record<string, unknown> = {}) =>
  addDailyExpenseBalance(creator, input(amount, extra));
const category = (name = "Supplies") =>
  createDailyExpenseCategory(creator, { name });
const history = (query: Record<string, unknown> = {}) =>
  listDailyExpenseTransactions(admin, { page: 1, pageSize: 25, ...query });
const correction = (
  transaction: DailyExpenseTransactionDTO,
  extra: Record<string, unknown> = {},
) => ({
  amount: transaction.amount,
  date: transaction.date,
  note: transaction.note ?? "",
  categoryId: transaction.category?.id ?? null,
  expectedVersion: transaction.version,
  ...extra,
});
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
        'TRUNCATE "DailyExpenseTransactionDeletion", "DailyExpenseTransaction", "DailyExpenseCategory", "DailyExpenseLedger", "AuditLog"',
      );
      const user = await db.user.create({
        data: {
          email: `daily-${randomUUID()}@example.test`,
          name: "Ledger administrator",
          role: "ADMIN",
        },
      });
      admin = { id: user.id, role: "ADMIN", status: "ACTIVE" };
      const editor = await db.user.create({
        data: {
          email: `daily-super-${randomUUID()}@example.test`,
          role: "SUPER_ADMIN",
        },
      });
      superAdmin = { id: editor.id, role: "SUPER_ADMIN", status: "ACTIVE" };
      const author = await db.user.create({
        data: {
          email: `daily-author-${randomUUID()}@example.test`,
          role: "SUPER_ADMIN",
        },
      });
      creator = { id: author.id, role: "SUPER_ADMIN", status: "ACTIVE" };
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

    it("allows admins to view the ledger but rejects every write without changing records or audits", async () => {
      const supplies = await category();
      const { transaction } = await balance("10.00");
      await expect(getDailyExpensesSummary(admin)).resolves.toMatchObject({
        currentBalance: "10.00",
      });
      await expect(listDailyExpenseCategories(admin)).resolves.toContainEqual(
        expect.objectContaining({ id: supplies.id }),
      );
      await expect(history()).resolves.toMatchObject({ total: 1 });
      const auditCount = await db.auditLog.count();
      const operations = [
        () => addDailyExpenseBalance(admin, input()),
        () =>
          addDailyExpense(admin, input("1.00", { categoryId: supplies.id })),
        () => createDailyExpenseCategory(admin, { name: "Blocked" }),
        () =>
          updateDailyExpenseCategory(admin, supplies.id, { name: "Blocked" }),
        () =>
          updateDailyExpenseCategory(admin, supplies.id, { archived: true }),
        () =>
          updateDailyExpenseCategory(admin, supplies.id, { archived: false }),
        () =>
          updateDailyExpenseTransaction(
            admin,
            transaction.id,
            correction(transaction),
          ),
        () =>
          deleteDailyExpenseTransaction(admin, transaction.id, {
            expectedVersion: 1,
          }),
      ];
      for (const operation of operations)
        await expect(operation()).rejects.toMatchObject({ status: 403 });
      expect(await db.dailyExpenseCategory.count()).toBe(1);
      expect(await listDailyExpenseCategories(admin)).toContainEqual(
        expect.objectContaining({
          id: supplies.id,
          name: "Supplies",
          archived: false,
        }),
      );
      await expectTotals("10.00", "10.00", "0.00");
      expect(await db.dailyExpenseTransaction.count()).toBe(1);
      expect(await db.auditLog.count()).toBe(auditCount);
    });

    it.each([
      { role: "ADMIN" as const },
      { status: "INACTIVE" as const },
      { status: "SUSPENDED" as const },
    ])(
      "reauthorizes persisted writers for creation, category changes, and retries: %j",
      async (change) => {
        const supplies = await category();
        const submission = input("10.00");
        await addDailyExpenseBalance(superAdmin, submission);
        const auditCount = await db.auditLog.count();
        await db.user.update({ where: { id: superAdmin.id }, data: change });
        const operations = [
          () => addDailyExpenseBalance(superAdmin, input()),
          () => addDailyExpenseBalance(superAdmin, submission),
          () =>
            addDailyExpense(
              superAdmin,
              input("1.00", { categoryId: supplies.id }),
            ),
          () => createDailyExpenseCategory(superAdmin, { name: "Blocked" }),
          () =>
            updateDailyExpenseCategory(superAdmin, supplies.id, {
              name: "Blocked",
            }),
          () =>
            updateDailyExpenseCategory(superAdmin, supplies.id, {
              archived: true,
            }),
          () =>
            updateDailyExpenseCategory(superAdmin, supplies.id, {
              archived: false,
            }),
        ];
        for (const operation of operations)
          await expect(operation()).rejects.toMatchObject({ status: 403 });
        expect(await db.dailyExpenseCategory.count()).toBe(1);
        expect(await listDailyExpenseCategories(admin)).toContainEqual(
          expect.objectContaining({
            id: supplies.id,
            name: "Supplies",
            archived: false,
          }),
        );
        await expectTotals("10.00", "10.00", "0.00");
        expect(await db.dailyExpenseTransaction.count()).toBe(1);
        expect(await db.auditLog.count()).toBe(auditCount);
      },
    );

    it("implements the required all-time sequence including overspending", async () => {
      expect(
        await db.employee.findUnique({ where: { userId: admin.id } }),
      ).toBeNull();
      await expectTotals("0.00", "0.00", "0.00");
      const supplies = await category();
      await balance("1000.00");
      await expectTotals("1000.00", "1000.00", "0.00");
      await addDailyExpense(
        creator,
        input("250.00", { categoryId: supplies.id }),
      );
      await expectTotals("750.00", "1000.00", "250.00");
      await addDailyExpense(
        creator,
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
      await addDailyExpense(
        creator,
        input("0.30", { categoryId: supplies.id }),
      );
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
      expect(await db.auditLog.count({ where: { actorId: creator.id } })).toBe(
        0,
      );
    });

    it("deduplicates concurrent normalized retries and records exactly one audit", async () => {
      const submission = input("5.00", { note: "Deposit" });
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          addDailyExpenseBalance(creator, submission),
        ),
      );
      expect(new Set(results.map((result) => result.transaction.id)).size).toBe(
        1,
      );
      expect(results.filter((result) => !result.replayed)).toHaveLength(1);
      expect(await db.dailyExpenseTransaction.count()).toBe(1);
      const id = results[0].transaction.id;
      expect(await db.auditLog.count({ where: { resourceId: id } })).toBe(1);
      const replay = await addDailyExpenseBalance(creator, {
        ...submission,
        amount: "5",
        note: " Deposit ",
      });
      expect(replay).toMatchObject({ replayed: true, transaction: { id } });
      await expectTotals("5.00", "5.00", "0.00");
    });

    it("rejects reused keys with changed payloads or actors and reauthorizes retries", async () => {
      const submission = input("5.00");
      await addDailyExpenseBalance(creator, submission);
      for (const change of [
        { amount: "6.00" },
        { date: "2024-01-02" },
        { note: "changed" },
      ])
        await expect(
          addDailyExpenseBalance(creator, { ...submission, ...change }),
        ).rejects.toMatchObject({ status: 409 });
      const other = await db.user.create({
        data: {
          email: `other-${randomUUID()}@example.test`,
          role: "SUPER_ADMIN",
        },
      });
      await expect(
        addDailyExpenseBalance(
          { id: other.id, role: "SUPER_ADMIN", status: "ACTIVE" },
          submission,
        ),
      ).rejects.toMatchObject({ status: 409 });
      for (const role of ["ADMIN", "EMPLOYEE", "MANAGE_DRIVER"])
        await expect(
          addDailyExpenseBalance({ ...creator, role }, submission),
        ).rejects.toMatchObject({ status: 403 });
      await expectTotals("5.00", "5.00", "0.00");
      expect(await db.dailyExpenseTransaction.count()).toBe(1);
    });

    it("handles simultaneous different submissions sharing a key as one success and one conflict", async () => {
      const submission = input("5.00");
      const results = await Promise.allSettled([
        addDailyExpenseBalance(creator, submission),
        addDailyExpenseBalance(creator, { ...submission, amount: "7.00" }),
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
          addDailyExpense(creator, input("15.03", { categoryId: supplies.id })),
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
      await addDailyExpense(
        creator,
        input("0.01", { categoryId: supplies.id }),
      );
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
        creator,
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
          createDailyExpenseCategory(creator, { name: "Should roll back" }),
        ).rejects.toBeDefined();
        await expect(
          updateDailyExpenseCategory(creator, supplies.id, {
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
      await updateDailyExpenseCategory(creator, travel.id, { archived: true });
      await expect(category("TrAvEl")).rejects.toMatchObject({ status: 409 });
      const supplies = await category("Supplies");
      await expect(
        updateDailyExpenseCategory(creator, supplies.id, { name: "TRAVEL" }),
      ).rejects.toMatchObject({ status: 409 });
      await updateDailyExpenseCategory(creator, travel.id, {
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
      await expect(addDailyExpense(creator, input())).rejects.toBeDefined();
      await expect(
        addDailyExpense(creator, input("1.00", { categoryId: "missing" })),
      ).rejects.toBeDefined();
      const travel = await category("Travel");
      const submission = input("12.00", { categoryId: travel.id });
      const posted = await addDailyExpense(creator, submission);
      await updateDailyExpenseCategory(creator, travel.id, { archived: true });
      await expect(
        addDailyExpense(creator, input("1.00", { categoryId: travel.id })),
      ).rejects.toBeDefined();
      expect((await history({ categoryId: travel.id })).items).toContainEqual(
        expect.objectContaining({
          id: posted.transaction.id,
          category: expect.objectContaining({ id: travel.id, archived: true }),
        }),
      );
      expect(await addDailyExpense(creator, submission)).toMatchObject({
        replayed: true,
        transaction: { id: posted.transaction.id },
      });
      await updateDailyExpenseCategory(creator, travel.id, {
        name: "Transport",
        archived: false,
      });
      expect((await history()).items[0].category?.name).toBe("Transport");
      await addDailyExpense(creator, input("1.00", { categoryId: travel.id }));
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
          creator,
          input("1.00", { categoryId: foreignCategory.id }),
        ),
      ).rejects.toBeDefined();
      await expect(
        updateDailyExpenseCategory(creator, foreignCategory.id, {
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
      await updateDailyExpenseCategory(creator, supplies.id, {
        archived: true,
      });
      await expect(
        direct({ type: "EXPENSE", categoryId: supplies.id }),
      ).rejects.toBeDefined();
      expect(await db.dailyExpenseTransaction.count()).toBe(0);
    });

    it("prevents uncontrolled rewrites/deletes, ledger configuration changes, and author deletion", async () => {
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
        db.user.delete({ where: { id: creator.id } }),
      ).rejects.toBeDefined();
      await expectTotals("12.50", "12.50", "0.00");
      expect((await history()).items[0].createdBy?.id).toBe(creator.id);
    });

    it("only permits active persisted super admins to edit records", async () => {
      const { transaction } = await balance("12.50");
      const edit = correction(transaction, { amount: "99.00" });
      for (const actor of [
        admin,
        { ...admin, role: "EMPLOYEE" },
        { ...admin, role: "MANAGE_DRIVER" },
        { ...admin, role: "SUPER_ADMIN" },
        { ...superAdmin, status: "INACTIVE" },
        { ...superAdmin, id: "missing" },
      ]) {
        await expect(
          updateDailyExpenseTransaction(actor, transaction.id, edit),
        ).rejects.toMatchObject({ status: 403 });
      }
      await db.user.update({
        where: { id: superAdmin.id },
        data: { status: "INACTIVE" },
      });
      await expect(
        updateDailyExpenseTransaction(superAdmin, transaction.id, edit),
      ).rejects.toMatchObject({ status: 403 });
      await expectTotals("12.50", "12.50", "0.00");
      expect(
        await db.auditLog.count({
          where: { action: "DAILY_EXPENSE_TRANSACTION_UPDATED" },
        }),
      ).toBe(0);
    });

    it("audits expense and balance edits atomically while preserving creators and creation retries", async () => {
      const supplies = await category();
      const travel = await category("Travel");
      const creation = input("100.00", { note: "Opening" });
      const originalBalance = await addDailyExpenseBalance(creator, creation);
      const originalExpense = await addDailyExpense(
        creator,
        input("25.00", { categoryId: supplies.id }),
      );
      const expenseEdit = correction(originalExpense.transaction, {
        amount: "30.50",
        date: "2024-01-02",
        categoryId: travel.id,
        note: "Corrected receipt",
      });
      const updatedExpense = await updateDailyExpenseTransaction(
        superAdmin,
        originalExpense.transaction.id,
        expenseEdit,
      );
      expect(updatedExpense).toMatchObject({
        replayed: false,
        transaction: {
          id: originalExpense.transaction.id,
          type: "EXPENSE",
          amount: "30.50",
          date: "2024-01-02",
          note: "Corrected receipt",
          category: { id: travel.id },
          version: 2,
          createdBy: originalExpense.transaction.createdBy,
          createdAt: originalExpense.transaction.createdAt,
        },
      });
      await updateDailyExpenseTransaction(
        superAdmin,
        originalBalance.transaction.id,
        correction(originalBalance.transaction, {
          amount: "120.00",
          note: "Corrected opening",
        }),
      );
      await expectTotals("89.50", "120.00", "30.50");
      expect(await db.dailyExpenseTransaction.count()).toBe(2);
      const audits = await db.auditLog.findMany({
        where: { action: "DAILY_EXPENSE_TRANSACTION_UPDATED" },
      });
      expect(audits).toHaveLength(2);
      expect(audits).toContainEqual(
        expect.objectContaining({
          actorId: superAdmin.id,
          resourceId: originalExpense.transaction.id,
          previousState: expect.objectContaining({
            amount: "25.00",
            version: 1,
          }),
          newState: expect.objectContaining({ amount: "30.50", version: 2 }),
        }),
      );
      await expect(
        addDailyExpenseBalance(creator, creation),
      ).resolves.toMatchObject({
        replayed: true,
        transaction: {
          id: originalBalance.transaction.id,
          amount: "120.00",
          version: 2,
        },
      });
      expect(await db.dailyExpenseTransaction.count()).toBe(2);
      await expect(
        updateDailyExpenseTransaction(
          superAdmin,
          originalExpense.transaction.id,
          expenseEdit,
        ),
      ).resolves.toMatchObject({ replayed: true, transaction: { version: 2 } });
      expect(
        await db.auditLog.count({
          where: { action: "DAILY_EXPENSE_TRANSACTION_UPDATED" },
        }),
      ).toBe(2);
    });

    it("rejects a stale edit instead of overwriting the winner under concurrency", async () => {
      const { transaction } = await balance("10.00");
      const results = await Promise.allSettled([
        updateDailyExpenseTransaction(
          superAdmin,
          transaction.id,
          correction(transaction, { amount: "11.00" }),
        ),
        updateDailyExpenseTransaction(
          superAdmin,
          transaction.id,
          correction(transaction, { amount: "12.00" }),
        ),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.find((result) => result.status === "rejected"),
      ).toMatchObject({
        reason: { code: "TRANSACTION_CONFLICT", status: 409 },
      });
      expect((await history()).items[0].version).toBe(2);
      expect(
        await db.auditLog.count({
          where: { action: "DAILY_EXPENSE_TRANSACTION_UPDATED" },
        }),
      ).toBe(1);
    });

    it("replays concurrent identical edits without creating a second audit or version", async () => {
      const { transaction } = await balance("10.00");
      const edit = correction(transaction, { amount: "12.00" });
      const results = await Promise.all([
        updateDailyExpenseTransaction(superAdmin, transaction.id, edit),
        updateDailyExpenseTransaction(superAdmin, transaction.id, edit),
      ]);
      expect(results.map(({ replayed }) => replayed).sort()).toEqual([
        false,
        true,
      ]);
      await expectTotals("12.00", "12.00", "0.00");
      expect((await history()).items[0].version).toBe(2);
      expect(
        await db.auditLog.count({
          where: { action: "DAILY_EXPENSE_TRANSACTION_UPDATED" },
        }),
      ).toBe(1);
    });

    it("validates edited dates, category shape, and missing or foreign-ledger records", async () => {
      const supplies = await category();
      const { transaction } = await balance("10.00");
      for (const patch of [
        { amount: "0.00" },
        { amount: "1.001" },
        { date: "9999-01-01" },
        { categoryId: supplies.id },
        { type: "EXPENSE" },
      ]) {
        await expect(
          updateDailyExpenseTransaction(
            superAdmin,
            transaction.id,
            correction(transaction, patch),
          ),
        ).rejects.toBeDefined();
      }
      await expect(
        updateDailyExpenseTransaction(
          superAdmin,
          "missing",
          correction(transaction),
        ),
      ).rejects.toMatchObject({ status: 404 });
      const otherLedger = await db.dailyExpenseLedger.create({
        data: {
          workspaceKey: `other-${randomUUID()}`,
          currency: "BDT",
          timezone: "Asia/Dhaka",
        },
      });
      const foreignCategory = await db.dailyExpenseCategory.create({
        data: { ledgerId: otherLedger.id, name: "Foreign" },
      });
      const foreignTransaction = await db.dailyExpenseTransaction.create({
        data: {
          ledgerId: otherLedger.id,
          type: "BALANCE_ADDED",
          amount: "5.00",
          date: new Date(`${date}T00:00:00Z`),
          createdById: admin.id,
          idempotencyKey: randomUUID(),
          payloadHash: "a".repeat(64),
        },
      });
      await expect(
        updateDailyExpenseTransaction(
          superAdmin,
          foreignTransaction.id,
          correction(transaction),
        ),
      ).rejects.toMatchObject({ status: 404 });
      const expense = await addDailyExpense(
        creator,
        input("1.00", { categoryId: supplies.id }),
      );
      for (const categoryId of [null, "missing", foreignCategory.id]) {
        await expect(
          updateDailyExpenseTransaction(
            superAdmin,
            expense.transaction.id,
            correction(expense.transaction, { categoryId }),
          ),
        ).rejects.toBeDefined();
      }
      await expectTotals("9.00", "10.00", "1.00");
    });

    it("allows keeping a historical archived category but rejects switching to one", async () => {
      const supplies = await category();
      const travel = await category("Travel");
      const { transaction } = await addDailyExpense(
        creator,
        input("1.00", { categoryId: supplies.id }),
      );
      await updateDailyExpenseCategory(creator, supplies.id, {
        archived: true,
      });
      await updateDailyExpenseCategory(creator, travel.id, { archived: true });
      await expect(
        updateDailyExpenseTransaction(
          superAdmin,
          transaction.id,
          correction(transaction, { categoryId: travel.id }),
        ),
      ).rejects.toMatchObject({ code: "INVALID_CATEGORY" });
      await expect(
        updateDailyExpenseTransaction(
          superAdmin,
          transaction.id,
          correction(transaction, { amount: "2.00" }),
        ),
      ).resolves.toMatchObject({
        transaction: {
          amount: "2.00",
          category: { id: supplies.id, archived: true },
        },
      });
    });

    it("rolls back the edit and version when its audit cannot be written", async () => {
      const { transaction } = await balance("10.00");
      await control.query(
        `CREATE FUNCTION fail_edit_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected audit failure'; END; $$`,
      );
      await control.query(
        'CREATE TRIGGER fail_edit_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION fail_edit_audit()',
      );
      try {
        await expect(
          updateDailyExpenseTransaction(
            superAdmin,
            transaction.id,
            correction(transaction, { amount: "20.00" }),
          ),
        ).rejects.toBeDefined();
        expect((await history()).items[0]).toMatchObject({
          amount: "10.00",
          version: 1,
        });
        await expectTotals("10.00", "10.00", "0.00");
      } finally {
        await control.query('DROP TRIGGER fail_edit_audit ON "AuditLog"');
        await control.query("DROP FUNCTION fail_edit_audit()");
      }
    });

    it("keeps database guards for edit authorization, immutable metadata, versions, and deletion", async () => {
      const { transaction } = await balance("10.00");
      const guarded = (actorId: string, sql: string, value: unknown) =>
        db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.daily_expenses_editor_id', ${actorId}, true)`;
          return tx.$executeRawUnsafe(sql, value, transaction.id);
        });
      await expect(
        guarded(
          admin.id,
          'UPDATE "DailyExpenseTransaction" SET "amount" = $1, "version" = "version" + 1 WHERE "id" = $2',
          "20.00",
        ),
      ).rejects.toBeDefined();
      for (const [field, value] of [
        ["createdById", superAdmin.id],
        ["payloadHash", "b".repeat(64)],
        ["idempotencyKey", randomUUID()],
        ["type", "EXPENSE"],
        ["amount", "0.00"],
        ["date", "9999-01-01"],
      ]) {
        await expect(
          guarded(
            superAdmin.id,
            `UPDATE "DailyExpenseTransaction" SET "${field}" = $1, "version" = "version" + 1 WHERE "id" = $2`,
            value,
          ),
        ).rejects.toBeDefined();
      }
      await expect(
        guarded(
          superAdmin.id,
          'UPDATE "DailyExpenseTransaction" SET "amount" = $1 WHERE "id" = $2',
          "20.00",
        ),
      ).rejects.toBeDefined();
      await expect(
        db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.daily_expenses_editor_id', ${admin.id}, true)`;
          return tx.dailyExpenseTransaction.delete({
            where: { id: transaction.id },
          });
        }),
      ).rejects.toBeDefined();
      await expectTotals("10.00", "10.00", "0.00");
    });

    it("deleting expense and balance records adjusts totals and removes them from every history filter", async () => {
      const supplies = await category();
      const deposit = await balance("100.00");
      const expense = await addDailyExpense(
        creator,
        input("30.25", { categoryId: supplies.id, note: "Delete receipt" }),
      );
      await expectTotals("69.75", "100.00", "30.25");
      await expect(
        deleteDailyExpenseTransaction(superAdmin, expense.transaction.id, {
          expectedVersion: expense.transaction.version,
        }),
      ).resolves.toEqual({ id: expense.transaction.id, replayed: false });
      await expectTotals("100.00", "100.00", "0.00");
      expect(
        (
          await history({
            type: "EXPENSE",
            categoryId: supplies.id,
            search: "Delete receipt",
          })
        ).total,
      ).toBe(0);
      expect((await history()).items.map(({ id }) => id)).toEqual([
        deposit.transaction.id,
      ]);
      await deleteDailyExpenseTransaction(superAdmin, deposit.transaction.id, {
        expectedVersion: deposit.transaction.version,
      });
      await expectTotals("0.00", "0.00", "0.00");
      expect(await history()).toMatchObject({
        items: [],
        total: 0,
        totalPages: 0,
      });
      expect(await db.dailyExpenseTransaction.findMany()).toEqual([]);
      const receipts = await db.dailyExpenseTransactionDeletion.findMany();
      expect(receipts).toHaveLength(2);
      expect(receipts.map(({ transactionId }) => transactionId).sort()).toEqual(
        [expense.transaction.id, deposit.transaction.id].sort(),
      );
      const audits = await db.auditLog.findMany({
        where: { action: "DAILY_EXPENSE_TRANSACTION_DELETED" },
      });
      expect(audits).toHaveLength(2);
      expect(audits).toContainEqual(
        expect.objectContaining({
          actorId: superAdmin.id,
          resourceId: expense.transaction.id,
          previousState: expect.objectContaining({
            amount: "30.25",
            version: 1,
          }),
          newState: { id: expense.transaction.id, deleted: true },
        }),
      );
    });

    it("prevents unauthorized or stale-role deletions and scopes records to this ledger", async () => {
      const { transaction } = await balance("5.00");
      const deletion = { expectedVersion: transaction.version };
      for (const actor of [
        admin,
        { ...admin, role: "EMPLOYEE" },
        { ...admin, role: "MANAGE_DRIVER" },
        { ...admin, role: "SUPER_ADMIN" },
        { ...superAdmin, status: "INACTIVE" },
      ]) {
        await expect(
          deleteDailyExpenseTransaction(actor, transaction.id, deletion),
        ).rejects.toMatchObject({ status: 403 });
      }
      await expect(
        deleteDailyExpenseTransaction(superAdmin, "missing", deletion),
      ).rejects.toMatchObject({ status: 404 });
      const foreignLedger = await db.dailyExpenseLedger.create({
        data: {
          workspaceKey: `foreign-delete-${randomUUID()}`,
          currency: "BDT",
          timezone: "Asia/Dhaka",
        },
      });
      const foreign = await db.dailyExpenseTransaction.create({
        data: {
          ledgerId: foreignLedger.id,
          type: "BALANCE_ADDED",
          amount: "7.00",
          date: new Date(`${date}T00:00:00Z`),
          createdById: admin.id,
          idempotencyKey: randomUUID(),
          payloadHash: "a".repeat(64),
        },
      });
      await expect(
        deleteDailyExpenseTransaction(superAdmin, foreign.id, deletion),
      ).rejects.toMatchObject({ status: 404 });
      await db.user.update({
        where: { id: superAdmin.id },
        data: { status: "SUSPENDED" },
      });
      await expect(
        deleteDailyExpenseTransaction(superAdmin, transaction.id, deletion),
      ).rejects.toMatchObject({ status: 403 });
      await expectTotals("5.00", "5.00", "0.00");
    });

    it("replays simultaneous deletes once and never recreates or edits a deleted record", async () => {
      const creation = input("10.00");
      const { transaction } = await addDailyExpenseBalance(creator, creation);
      const results = await Promise.all([
        deleteDailyExpenseTransaction(superAdmin, transaction.id, {
          expectedVersion: 1,
        }),
        deleteDailyExpenseTransaction(superAdmin, transaction.id, {
          expectedVersion: 1,
        }),
      ]);
      expect(results.map(({ replayed }) => replayed).sort()).toEqual([
        false,
        true,
      ]);
      await expect(
        addDailyExpenseBalance(creator, creation),
      ).rejects.toMatchObject({ code: "TRANSACTION_DELETED", status: 409 });
      await expect(
        updateDailyExpenseTransaction(
          superAdmin,
          transaction.id,
          correction(transaction),
        ),
      ).rejects.toMatchObject({ code: "TRANSACTION_DELETED", status: 409 });
      expect(await db.dailyExpenseTransaction.count()).toBe(0);
      expect(await db.dailyExpenseTransactionDeletion.count()).toBe(1);
      expect(
        await db.auditLog.count({
          where: { action: "DAILY_EXPENSE_TRANSACTION_DELETED" },
        }),
      ).toBe(1);
      await expectTotals("0.00", "0.00", "0.00");
    });

    it("rejects deletion of an edited version until the latest amount has been reviewed", async () => {
      const { transaction } = await balance("100.00");
      const changed = await updateDailyExpenseTransaction(
        superAdmin,
        transaction.id,
        correction(transaction, { amount: "200.00" }),
      );
      await expect(
        deleteDailyExpenseTransaction(superAdmin, transaction.id, {
          expectedVersion: transaction.version,
        }),
      ).rejects.toMatchObject({ code: "TRANSACTION_CONFLICT", status: 409 });
      await expectTotals("200.00", "200.00", "0.00");
      await deleteDailyExpenseTransaction(superAdmin, transaction.id, {
        expectedVersion: changed.transaction.version,
      });
      await expectTotals("0.00", "0.00", "0.00");
    });

    it("serializes edit/delete races without overwriting a deleted or edited version", async () => {
      const { transaction } = await balance("10.00");
      const results = await Promise.allSettled([
        updateDailyExpenseTransaction(
          superAdmin,
          transaction.id,
          correction(transaction, { amount: "20.00" }),
        ),
        deleteDailyExpenseTransaction(superAdmin, transaction.id, {
          expectedVersion: 1,
        }),
      ]);
      expect(
        results.filter(({ status }) => status === "fulfilled"),
      ).toHaveLength(1);
      expect(results.find(({ status }) => status === "rejected")).toMatchObject(
        { reason: { status: 409 } },
      );
      const stored = await db.dailyExpenseTransaction.findUnique({
        where: { id: transaction.id },
      });
      if (stored) expect(stored.version).toBe(2);
      await expectTotals(
        stored ? "20.00" : "0.00",
        stored ? "20.00" : "0.00",
        "0.00",
      );
    });

    it("deletes historical archived-category expenses and allows negative balances after deleting funds", async () => {
      const supplies = await category();
      const deposit = await balance("10.00");
      const expense = await addDailyExpense(
        creator,
        input("20.00", { categoryId: supplies.id }),
      );
      await updateDailyExpenseCategory(creator, supplies.id, {
        archived: true,
      });
      await deleteDailyExpenseTransaction(superAdmin, deposit.transaction.id, {
        expectedVersion: 1,
      });
      await expectTotals("-20.00", "0.00", "20.00");
      await deleteDailyExpenseTransaction(superAdmin, expense.transaction.id, {
        expectedVersion: 1,
      });
      await expectTotals("0.00", "0.00", "0.00");
    });

    it("rolls back a deletion and its balance effect when the audit fails", async () => {
      const { transaction } = await balance("10.00");
      await control.query(
        `CREATE FUNCTION fail_delete_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected audit failure'; END; $$`,
      );
      await control.query(
        'CREATE TRIGGER fail_delete_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION fail_delete_audit()',
      );
      try {
        await expect(
          deleteDailyExpenseTransaction(superAdmin, transaction.id, {
            expectedVersion: 1,
          }),
        ).rejects.toBeDefined();
        expect((await history()).items[0]).toMatchObject({
          id: transaction.id,
          version: 1,
        });
        expect(
          await db.dailyExpenseTransaction.findUnique({
            where: { id: transaction.id },
          }),
        ).not.toBeNull();
        expect(await db.dailyExpenseTransactionDeletion.count()).toBe(0);
        await expectTotals("10.00", "10.00", "0.00");
      } finally {
        await control.query('DROP TRIGGER fail_delete_audit ON "AuditLog"');
        await control.query("DROP FUNCTION fail_delete_audit()");
      }
    });

    it("database guards authorize physical deletion and prevent reuse or removal of its receipt", async () => {
      const creation = input("10.00");
      const { transaction } = await addDailyExpenseBalance(creator, creation);
      const stored = await db.dailyExpenseTransaction.findUniqueOrThrow({
        where: { id: transaction.id },
      });
      await expect(
        db.dailyExpenseTransaction.delete({ where: { id: transaction.id } }),
      ).rejects.toBeDefined();
      await expect(
        db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.daily_expenses_editor_id', ${admin.id}, true)`;
          return tx.dailyExpenseTransaction.delete({
            where: { id: transaction.id },
          });
        }),
      ).rejects.toBeDefined();
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.daily_expenses_editor_id', ${superAdmin.id}, true)`;
        await tx.dailyExpenseTransaction.delete({
          where: { id: transaction.id },
        });
      });
      expect(
        await db.dailyExpenseTransaction.findUnique({
          where: { id: transaction.id },
        }),
      ).toBeNull();
      await expect(
        db.dailyExpenseTransaction.create({ data: stored }),
      ).rejects.toBeDefined();
      await expect(
        db.dailyExpenseTransaction.create({
          data: { ...stored, id: randomUUID() },
        }),
      ).rejects.toBeDefined();
      await expect(
        db.dailyExpenseTransactionDeletion.delete({
          where: { transactionId: transaction.id },
        }),
      ).rejects.toBeDefined();
      await expect(
        db.dailyExpenseTransactionDeletion.update({
          where: { transactionId: transaction.id },
          data: { idempotencyKey: randomUUID() },
        }),
      ).rejects.toBeDefined();
      await expect(
        addDailyExpenseBalance(creator, creation),
      ).rejects.toMatchObject({ code: "TRANSACTION_DELETED" });
      await expect(
        addDailyExpenseBalance(creator, { ...creation, amount: "20.00" }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      await expectTotals("0.00", "0.00", "0.00");
    });

    it("serializes deletion against a retried creation without restoring the balance", async () => {
      const creation = input("10.00");
      const { transaction } = await addDailyExpenseBalance(creator, creation);
      const results = await Promise.allSettled([
        deleteDailyExpenseTransaction(superAdmin, transaction.id, {
          expectedVersion: 1,
        }),
        addDailyExpenseBalance(creator, creation),
      ]);
      expect(results[0]).toMatchObject({ status: "fulfilled" });
      if (results[1].status === "fulfilled") {
        expect(results[1].value).toMatchObject({ replayed: true });
      } else {
        expect(results[1].reason).toMatchObject({
          code: "TRANSACTION_DELETED",
        });
      }
      expect(await db.dailyExpenseTransaction.count()).toBe(0);
      expect(await db.dailyExpenseTransactionDeletion.count()).toBe(1);
      await expectTotals("0.00", "0.00", "0.00");
    });

    it("exports all filtered records across pages with corrected values and no deleted records", async () => {
      const supplies = await category();
      await balance("100.00");
      const entries = [];
      for (let index = 0; index < 30; index++) {
        entries.push(
          await addDailyExpense(
            creator,
            input("0.10", {
              categoryId: supplies.id,
              note: `Paper ${index + 1}`,
            }),
          ),
        );
      }
      const corrected = await updateDailyExpenseTransaction(
        superAdmin,
        entries[0].transaction.id,
        correction(entries[0].transaction, { amount: "0.15" }),
      );
      await deleteDailyExpenseTransaction(
        superAdmin,
        entries[1].transaction.id,
        { expectedVersion: 1 },
      );
      await addDailyExpense(
        creator,
        input("10.00", {
          categoryId: supplies.id,
          note: "Other supplies",
          date: "2024-01-02",
        }),
      );
      const filters = {
        from: date,
        to: date,
        type: "EXPENSE",
        categoryId: supplies.id,
        search: "paper",
        page: "2",
        pageSize: "1",
      };
      const report = await getDailyExpenseReportData(superAdmin, filters);
      expect(report.items).toHaveLength(29);
      expect(report.items).toContainEqual(
        expect.objectContaining({
          id: corrected.transaction.id,
          amount: "0.15",
          version: 2,
        }),
      );
      expect(report.items.map(({ id }) => id)).not.toContain(
        entries[1].transaction.id,
      );
      expect(report).toMatchObject({
        categoryName: "Supplies",
        allTime: {
          currentBalance: "87.05",
          totalBalanceAdded: "100.00",
          totalExpenses: "12.95",
        },
        filtered: {
          count: 29,
          totalBalanceAdded: "0.00",
          totalExpenses: "2.95",
          netChange: "-2.95",
        },
      });
      expect(Number.isFinite(new Date(report.generatedAt).getTime())).toBe(
        true,
      );
      const listed = await history({ ...filters, page: 1, pageSize: 100 });
      expect(report.items.map(({ id }) => id)).toEqual(
        listed.items.map(({ id }) => id),
      );
    });

    it("uses literal note search and includes archived category names in an empty or matching report", async () => {
      const supplies = await category("Office supplies");
      await balance("25.00");
      const expense = await addDailyExpense(
        creator,
        input("1.23", { categoryId: supplies.id, note: "100%_matched" }),
      );
      await addDailyExpense(
        creator,
        input("2.00", { categoryId: supplies.id, note: "100 percent matched" }),
      );
      await updateDailyExpenseCategory(creator, supplies.id, {
        archived: true,
      });
      const matched = await getDailyExpenseReportData(superAdmin, {
        search: "%_",
        categoryId: supplies.id,
      });
      expect(matched.items.map(({ id }) => id)).toEqual([
        expense.transaction.id,
      ]);
      expect(matched.categoryName).toContain("Office supplies");
      const empty = await getDailyExpenseReportData(superAdmin, {
        from: "2024-02-01",
        categoryId: supplies.id,
      });
      expect(empty).toMatchObject({
        items: [],
        filtered: {
          count: 0,
          totalBalanceAdded: "0.00",
          totalExpenses: "0.00",
          netChange: "0.00",
        },
        allTime: {
          currentBalance: "21.77",
          totalBalanceAdded: "25.00",
          totalExpenses: "3.23",
        },
      });
    });

    it("rejects unauthorized report entry points and foreign category scope before exposing data", async () => {
      for (const actor of [
        admin,
        { ...admin, role: "EMPLOYEE" },
        { ...admin, role: "MANAGE_DRIVER" },
        { ...superAdmin, status: "SUSPENDED" },
      ]) {
        await expect(
          getDailyExpenseReportData(actor, {}),
        ).rejects.toMatchObject({ status: 403 });
      }
      expect(await db.dailyExpenseLedger.count()).toBe(0);
      const other = await db.dailyExpenseLedger.create({
        data: {
          workspaceKey: `report-foreign-${randomUUID()}`,
          currency: "BDT",
          timezone: "Asia/Dhaka",
        },
      });
      const foreignCategory = await db.dailyExpenseCategory.create({
        data: { ledgerId: other.id, name: "Foreign" },
      });
      await expect(
        getDailyExpenseReportData(superAdmin, {
          categoryId: foreignCategory.id,
        }),
      ).rejects.toMatchObject({ code: "INVALID_CATEGORY" });
      await expect(
        getDailyExpenseReportData(superAdmin, { ledgerId: other.id }),
      ).rejects.toBeDefined();
      await expect(
        getDailyExpenseReportData(superAdmin, {
          from: "2024-02-01",
          to: "2024-01-01",
        }),
      ).rejects.toBeDefined();
    });

    it("keeps large filtered totals exact and rejects reports above the row limit instead of truncating", async () => {
      const { ledger } = await getDailyExpensesSummary(admin);
      await db.dailyExpenseTransaction.createMany({
        data: Array.from({ length: 10000 }, (_, index) => ({
          ledgerId: ledger.id,
          type: "BALANCE_ADDED" as const,
          amount: index === 9999 ? "0.01" : "9999999999999999.99",
          date: new Date(`${date}T00:00:00Z`),
          createdById: admin.id,
          idempotencyKey: randomUUID(),
          payloadHash: "a".repeat(64),
        })),
      });
      const expectedCents =
        BigInt("999999999999999999") * BigInt(9999) + BigInt(1);
      const expected = `${expectedCents / BigInt(100)}.${String(expectedCents % BigInt(100)).padStart(2, "0")}`;
      const report = await getDailyExpenseReportData(superAdmin, {});
      expect(report.items).toHaveLength(10000);
      expect(report.filtered).toMatchObject({
        count: 10000,
        totalBalanceAdded: expected,
        totalExpenses: "0.00",
        netChange: expected,
      });
      expect(report.allTime).toMatchObject({
        currentBalance: expected,
        totalBalanceAdded: expected,
      });
      await balance("1.00");
      await expect(
        getDailyExpenseReportData(superAdmin, {}),
      ).rejects.toMatchObject({ code: "REPORT_TOO_LARGE", status: 400 });
    }, 30_000);

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
      await addDailyExpense(
        creator,
        input("25.00", { categoryId: supplies.id }),
      );
      await updateDailyExpenseCategory(creator, supplies.id, {
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
        creator,
        input("20.00", {
          note: "Paper",
          categoryId: supplies.id,
          date: "2024-01-02",
        }),
      );
      const second = await addDailyExpense(
        creator,
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
