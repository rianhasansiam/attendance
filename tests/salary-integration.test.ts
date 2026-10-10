import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
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

const isolated = vi.hoisted(() => ({
  client: undefined as PrismaClient | undefined,
}));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ AUTH_SECRET: "salary-test-secret-at-least-32-characters" }),
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
  calculateSalaries,
  listSalaryEmployees,
  salaryStatementForExport,
  saveSalarySettings,
} from "@/modules/salary/service";
import * as reports from "@/modules/reports/service";
import type { Actor } from "@/modules/management/permissions";
import { deleteIdentity } from "@/modules/management/delete-identity";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `salary_test_${randomUUID().replaceAll("-", "")}`;
const now = new Date("2026-10-10T05:00:00.000Z");
const period = "2026-09";
let control: Client;
let db: PrismaClient;
let superAdmin: Actor;
let employeeId: string;
let officeId: string;
let departmentId: string;
let shiftId: string;

const setting = (
  effectiveMonth = period,
  baseSalary = "30000",
  overtimeHourlyRate = "200",
) =>
  saveSalarySettings(superAdmin, employeeId, {
    effectiveMonth,
    baseSalary,
    overtimeHourlyRate,
  });
const calculate = (payrollPeriod = period, ids = [employeeId]) =>
  calculateSalaries(
    superAdmin,
    { period: payrollPeriod, employeeIds: ids },
    now,
  );
const listing = (query: Record<string, unknown> = {}) =>
  listSalaryEmployees(superAdmin, { period, officeId, ...query }, now);
async function attendance(
  extra: Partial<Prisma.AttendanceUncheckedCreateInput> = {},
) {
  return db.attendance.create({
    data: {
      employeeId,
      officeId,
      shiftId,
      attendanceDate: new Date("2026-09-01T00:00:00Z"),
      scheduledStartAt: new Date("2026-09-01T03:00:00Z"),
      scheduledEndAt: new Date("2026-09-01T11:30:00Z"),
      checkInAt: new Date("2026-09-01T03:00:00Z"),
      checkOutAt: new Date("2026-09-01T12:15:00Z"),
      status: "PRESENT",
      workedMinutes: 555,
      overtimeMinutes: 45,
      ...extra,
    },
  });
}

describe.skipIf(!databaseUrl)(
  "Salary services against isolated PostgreSQL",
  () => {
    beforeAll(async () => {
      if (!databaseUrl || !new URL(databaseUrl).pathname.includes("test"))
        throw new Error(
          "Salary integration tests require a disposable database with 'test' in its name",
        );
      control = new Client({ connectionString: databaseUrl });
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
            connectionString: databaseUrl,
            options: `-c search_path=${schema}`,
            application_name: schema,
          },
          { schema },
        ),
      });
      isolated.client = db;
    }, 60000);

    beforeEach(async () => {
      vi.stubEnv("DAILY_EXPENSES_CURRENCY", "BDT");
      vi.stubEnv("DAILY_EXPENSES_TIMEZONE", "Asia/Dhaka");
      await control.query(
        'TRUNCATE "Office", "User", "Shift", "Department" CASCADE',
      );
      superAdmin = await db.user.create({
        data: {
          email: `${randomUUID()}@example.test`,
          name: "Salary administrator",
          role: "SUPER_ADMIN",
        },
        select: { id: true, role: true },
      });
      officeId = (
        await db.office.create({
          data: {
            name: "Salary office",
            address: "Test office",
            latitude: 0,
            longitude: 0,
            timezone: "Asia/Dhaka",
            weekendDays: [5, 6],
          },
        })
      ).id;
      departmentId = (
        await db.department.create({ data: { name: "Test department" } })
      ).id;
      shiftId = (
        await db.shift.create({
          data: {
            name: "Day",
            startTime: "09:00",
            endTime: "17:30",
            timezone: "Asia/Dhaka",
          },
        })
      ).id;
      employeeId = (
        await db.employee.create({
          data: {
            employeeCode: "EMP001",
            office: { connect: { id: officeId } },
            department: { connect: { id: departmentId } },
            joinedAt: new Date("2026-09-01T00:00:00Z"),
            user: {
              create: {
                email: `${randomUUID()}@example.test`,
                name: "Employee with a long full name for payroll review",
                designation: "Engineer",
              },
            },
          },
        })
      ).id;
    });

    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await db?.$disconnect();
      if (control) {
        await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await control.end();
      }
    });

    it.each(["ADMIN", "EMPLOYEE", "MANAGE_DRIVER"] as const)(
      "denies %s every confidential service before looking up employees",
      async (role) => {
        const actor = { id: superAdmin.id, role };
        for (const operation of [
          () => listSalaryEmployees(actor, { period }),
          () =>
            saveSalarySettings(actor, "missing", {
              effectiveMonth: period,
              baseSalary: "0",
              overtimeHourlyRate: "0",
            }),
          () =>
            calculateSalaries(actor, { period, employeeIds: ["missing"] }, now),
          () =>
            salaryStatementForExport(
              actor,
              { employeeId: "missing", period, token: "invalid" },
              now,
            ),
        ])
          await expect(operation()).rejects.toMatchObject({
            code: "FORBIDDEN",
            status: 403,
          });
        expect(await db.salarySetting.count()).toBe(0);
        expect(await db.auditLog.count()).toBe(0);
      },
    );

    it("blocks missing rates, accepts zero rates, and supports organization-wide super admin search with office/department filters", async () => {
      expect((await listing()).items[0].settings).toBeNull();
      await expect(calculate()).rejects.toMatchObject({
        code: "SALARY_SETTINGS_MISSING",
      });
      await setting(period, "0", "0");
      expect((await calculate())[0]).toMatchObject({
        baseSalary: "0.00",
        overtimeHourlyRate: "0.00",
        overtimeEarnings: "0.00",
        totalSalary: "0.00",
      });
      expect(await listing({ search: "EMP001", departmentId })).toMatchObject({
        total: 1,
        currentPeriod: "2026-10",
        currency: "BDT",
        timezone: "Asia/Dhaka",
      });
      expect(await listing({ officeId: "different-office" })).toMatchObject({
        total: 0,
        items: [],
      });
      expect(
        await listing({ departmentId: "different-department" }),
      ).toMatchObject({ total: 0, items: [] });
      await expect(
        calculate(period, ["missing-employee"]),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    });

    it("preserves effective months, concurrent same-month revisions, actor/time and audit history", async () => {
      const august = await setting("2026-08", "10000", "100");
      await setting("2026-10", "50000", "500");
      const revisions = await Promise.all([
        setting(period, "30000", "200"),
        setting(period, "32000", "220"),
      ]);
      expect(revisions.map((revision) => revision.revision).sort()).toEqual([
        1, 2,
      ]);
      expect((await listing()).items[0].settings?.id).toBe(
        revisions.find((revision) => revision.revision === 2)?.id,
      );
      expect(
        (
          await listSalaryEmployees(
            superAdmin,
            { period: "2026-08", officeId },
            now,
          )
        ).items[0].settings?.id,
      ).toBe(august.id);
      expect(
        (
          await listSalaryEmployees(
            superAdmin,
            { period: "2026-07", officeId },
            now,
          )
        ).items[0].settings,
      ).toBeNull();
      expect(await db.salarySetting.count()).toBe(4);
      const audits = await db.auditLog.findMany({
        where: { resource: "salary-settings" },
        orderBy: { createdAt: "asc" },
      });
      expect(audits).toHaveLength(4);
      expect(
        audits.every(
          (audit) =>
            audit.actorId === superAdmin.id && audit.createdAt instanceof Date,
        ),
      ).toBe(true);
      expect(audits.at(-1)?.previousState).toMatchObject({ revision: 1 });
      expect(revisions[0].createdBy?.id).toBe(superAdmin.id);
    });

    it("enforces nonnegative finite amounts, month boundaries and append-only financial rows in PostgreSQL", async () => {
      const saved = await setting();
      await expect(
        db.salarySetting.update({
          where: { id: saved.id },
          data: { baseSalary: "99" },
        }),
      ).rejects.toThrow("immutable");
      const raw =
        'INSERT INTO "SalarySetting" ("id", "employeeId", "effectiveMonth", "revision", "baseSalary", "overtimeHourlyRate") VALUES ($1, $2, $3, $4, $5, $6)';
      for (const [date, revision, base, rate] of [
        ["2026-09-01", 2, "-1", "0"],
        ["2026-09-01", 2, "0", "NaN"],
        ["2026-09-01", 2, "NaN", "0"],
        ["2026-09-02", 2, "0", "0"],
        ["2026-09-01", 0, "0", "0"],
      ])
        await expect(
          control.query(raw, [
            randomUUID(),
            employeeId,
            date,
            revision,
            base,
            rate,
          ]),
        ).rejects.toThrow();
      for (const amount of ["-1", "1.001", "Infinity", "NaN"])
        await expect(setting(period, amount)).rejects.toThrow();
      expect(await db.salarySetting.count()).toBe(1);
    });

    it("uses one bounded authoritative report call for multiple employees and keeps statements isolated", async () => {
      await setting();
      await attendance();
      const other = await db.employee.create({
        data: {
          employeeCode: "OTHER002",
          office: { connect: { id: officeId } },
          user: {
            create: {
              email: `${randomUUID()}@example.test`,
              name: "Other employee",
            },
          },
        },
      });
      await saveSalarySettings(superAdmin, other.id, {
        effectiveMonth: period,
        baseSalary: "100",
        overtimeHourlyRate: "20",
      });
      await attendance({
        employeeId: other.id,
        overtimeMinutes: 120,
        checkOutAt: new Date("2026-09-01T13:30:00Z"),
        workedMinutes: 630,
      });
      const authoritative = vi.spyOn(reports, "reportRecords");
      const calculations = await calculate(period, [employeeId, other.id]);
      expect(authoritative).toHaveBeenCalledOnce();
      expect(authoritative).toHaveBeenCalledWith(
        superAdmin,
        expect.objectContaining({ from: "2026-09-01", to: "2026-09-30" }),
        now,
        [employeeId, other.id],
      );
      expect(calculations[0]).toMatchObject({
        employee: { id: employeeId },
        payableOvertimeMinutes: 45,
        overtimeEarnings: "150.00",
        monthlyBaseSalary: "30000.00",
        baseSalary: "25384.62",
        totalSalary: "25534.62",
      });
      expect(calculations[1]).toMatchObject({
        employee: { id: other.id },
        payableOvertimeMinutes: 120,
        overtimeEarnings: "40.00",
        monthlyBaseSalary: "100.00",
        baseSalary: "84.62",
        totalSalary: "124.62",
      });
      expect(
        calculations.every(
          (calculation) => calculation.attendance.length === 1,
        ),
      ).toBe(true);
      const statement = await salaryStatementForExport(
        superAdmin,
        { employeeId, period, token: calculations[0].token },
        new Date(now.valueOf() + 1000),
      );
      expect(statement).toEqual(calculations[0]);
      await expect(
        salaryStatementForExport(
          superAdmin,
          { employeeId: other.id, period, token: calculations[0].token },
          now,
        ),
      ).rejects.toMatchObject({ code: "SALARY_CALCULATION_INVALID" });
      authoritative.mockRestore();
    });

    it("retains the shared late-arrival offset and actual-lateness adjustment after approval", async () => {
      await setting();
      const record = await attendance({
        status: "LATE",
        checkInAt: new Date("2026-09-01T03:30:00Z"),
        checkOutAt: new Date("2026-09-01T12:00:00Z"),
        lateMinutes: 30,
        workedMinutes: 510,
        overtimeMinutes: 0,
      });
      const [before] = await calculate();
      const report = await reports.getReport(superAdmin, {
        from: "2026-09-01",
        to: "2026-09-30",
        format: "json",
        page: 1,
        pageSize: 100,
      });
      expect(before.payableOvertimeMinutes).toBe(
        "summary" in report ? report.summary.overtimeMinutes : NaN,
      );
      expect(before).toMatchObject({
        payableOvertimeMinutes: -30,
        overtimeEarnings: "-100.00",
        totalSalary: "25284.62",
      });
      await db.lateApprovalRequest.create({
        data: {
          attendanceId: record.id,
          status: "APPROVED",
          checkInAt: record.checkInAt!,
          lateMinutes: 30,
          reason: "Transport delay",
          reviewedById: superAdmin.id,
          reviewedAt: now,
        },
      });
      const [after] = await calculate();
      expect(after.attendance[0]).toMatchObject({
        status: "PRESENT",
        actualStatus: "LATE",
        isExcusedLate: true,
      });
      expect(after.payableOvertimeMinutes).toBe(before.payableOvertimeMinutes);
      await expect(
        salaryStatementForExport(
          superAdmin,
          { employeeId, period, token: before.token },
          now,
        ),
      ).rejects.toMatchObject({ code: "SALARY_SOURCE_CHANGED" });
    });

    it("requires recalculation after attendance details or settings change, including unchanged totals", async () => {
      await setting();
      const record = await attendance();
      const [before] = await calculate();
      await db.attendance.update({
        where: { id: record.id },
        data: { lateReason: "Updated attendance details" },
      });
      await expect(
        salaryStatementForExport(
          superAdmin,
          { employeeId, period, token: before.token },
          now,
        ),
      ).rejects.toMatchObject({ code: "SALARY_SOURCE_CHANGED" });
      const [detailsCurrent] = await calculate();
      expect(detailsCurrent.totalSalary).toBe(before.totalSalary);
      await setting(period, "30000", "200");
      await expect(
        salaryStatementForExport(
          superAdmin,
          { employeeId, period, token: detailsCurrent.token },
          now,
        ),
      ).rejects.toMatchObject({ code: "SALARY_SOURCE_CHANGED" });
      const [fresh] = await calculate();
      const anotherSuperAdmin = {
        id: "another-super-admin",
        role: "SUPER_ADMIN",
      } as const;
      await expect(
        salaryStatementForExport(
          anotherSuperAdmin,
          { employeeId, period, token: fresh.token },
          now,
        ),
      ).rejects.toMatchObject({ code: "SALARY_CALCULATION_INVALID" });
    });

    it("blocks completed legacy unknown overtime and uses configured currency instead of hardcoded amounts", async () => {
      await setting();
      await attendance({ scheduledEndAt: null, overtimeMinutes: null });
      await expect(calculate()).rejects.toMatchObject({
        code: "SALARY_OVERTIME_UNKNOWN",
      });
      await db.attendance.deleteMany();
      vi.stubEnv("DAILY_EXPENSES_CURRENCY", "USD");
      expect((await calculate())[0].currency).toBe("USD");
    });

    it("selects authoritative attendance dates at month and overnight boundaries", async () => {
      await setting();
      await attendance({
        attendanceDate: new Date("2026-08-31T00:00:00Z"),
        checkInAt: new Date("2026-08-31T16:00:00Z"),
        checkOutAt: new Date("2026-09-01T03:30:00Z"),
        scheduledEndAt: new Date("2026-09-01T01:30:00Z"),
        workedMinutes: 690,
      });
      await attendance({
        attendanceDate: new Date("2026-09-30T00:00:00Z"),
        checkInAt: new Date("2026-09-30T16:00:00Z"),
        checkOutAt: new Date("2026-10-01T03:30:00Z"),
        scheduledEndAt: new Date("2026-10-01T01:30:00Z"),
        workedMinutes: 690,
      });
      const [calculation] = await calculate();
      expect(calculation.attendance.map((row) => row.date)).toEqual([
        "2026-09-30",
      ]);
      expect(calculation.payableOvertimeMinutes).toBe(120);
      expect(calculation.attendance[0].checkOutAt).toBe(
        "2026-10-01T03:30:00.000Z",
      );
    });

    it("uses the configured timezone for current month and preserves leave, holiday, weekend and incomplete classifications without future absences", async () => {
      await setting();
      await db.employeeShift.create({
        data: {
          employeeId,
          shiftId,
          startDate: new Date("2026-09-01T00:00:00Z"),
        },
      });
      await db.leave.create({
        data: {
          employeeId,
          startDate: new Date("2026-10-04T00:00:00Z"),
          endDate: new Date("2026-10-04T00:00:00Z"),
          reason: "Approved leave",
          status: "APPROVED",
        },
      });
      await db.holiday.create({
        data: {
          date: new Date("2026-10-05T00:00:00Z"),
          name: "Office holiday",
          officeId,
        },
      });
      await attendance({
        attendanceDate: new Date("2026-10-06T00:00:00Z"),
        checkInAt: new Date("2026-10-06T03:00:00Z"),
        checkOutAt: null,
        workedMinutes: 0,
        overtimeMinutes: 0,
      });
      const [calculation] = await calculate("2026-10");
      expect(calculation.ongoing).toBe(true);
      expect(
        calculation.attendance.every((row) => row.date <= "2026-10-10"),
      ).toBe(true);
      expect(
        calculation.attendance.find((row) => row.date === "2026-10-04")?.status,
      ).toBe("LEAVE");
      expect(
        calculation.attendance.find((row) => row.date === "2026-10-05")?.status,
      ).toBe("HOLIDAY");
      expect(
        calculation.attendance.find((row) => row.date === "2026-10-06")
          ?.incomplete,
      ).toBe(true);
      expect(
        calculation.attendance.some((row) => row.status === "WEEKEND"),
      ).toBe(true);
      const localOctober = await listSalaryEmployees(
        superAdmin,
        { period },
        new Date("2026-09-30T18:30:00Z"),
      );
      expect(localOctober.currentPeriod).toBe("2026-10");
    });

    it("retains revision history when established employee and actor deletion clears their references", async () => {
      const saved = await setting();
      await db.employee.delete({ where: { id: employeeId } });
      const deletionActor = await db.user.create({
        data: { email: `${randomUUID()}@example.test`, role: "SUPER_ADMIN" },
      });
      await db.$transaction(async (tx) => {
        await deleteIdentity(tx, deletionActor, superAdmin.id, undefined, {});
      });
      expect(
        await db.salarySetting.findUnique({ where: { id: saved.id } }),
      ).toMatchObject({
        employeeId: null,
        createdById: null,
        baseSalary: new Prisma.Decimal("30000"),
        revision: 1,
      });
    });

    it("uses inclusive custom dates for authoritative attendance and range base pay", async () => {
      await setting();
      const dated = async (day: string, minutes: number) =>
        attendance({
          attendanceDate: new Date(`${day}T00:00:00Z`),
          scheduledStartAt: new Date(`${day}T03:00:00Z`),
          scheduledEndAt: new Date(`${day}T11:30:00Z`),
          checkInAt: new Date(`${day}T03:00:00Z`),
          checkOutAt: new Date(
            new Date(`${day}T11:30:00Z`).valueOf() + minutes * 60000,
          ),
          workedMinutes: 510 + minutes,
          overtimeMinutes: minutes,
        });
      await dated("2026-09-01", 45);
      await dated("2026-09-15", 75);
      const outside = await dated("2026-09-16", 150);
      const range = { period, from: "2026-09-01", to: "2026-09-15" };
      const authoritative = vi.spyOn(reports, "reportRecords");
      const [calculation] = await calculateSalaries(
        superAdmin,
        { ...range, employeeIds: [employeeId] },
        now,
      );
      expect(authoritative).toHaveBeenCalledOnce();
      expect(authoritative).toHaveBeenCalledWith(
        superAdmin,
        expect.objectContaining({ from: range.from, to: range.to }),
        now,
        [employeeId],
      );
      authoritative.mockRestore();
      expect(calculation).toMatchObject({
        ...range,
        monthlyBaseSalary: "30000.00",
        baseSalary: "12692.31",
        calendarDays: 15,
        weekendDays: 4,
        payableDays: 11,
        payableOvertimeMinutes: 120,
        overtimeEarnings: "400.00",
        totalSalary: "13092.31",
        ongoing: false,
      });
      expect(calculation.attendance.map((row) => row.date)).toEqual([
        range.from,
        range.to,
      ]);
      expect(await listing(range)).toMatchObject({
        ...range,
        today: "2026-10-10",
        ongoing: false,
      });
      expect(
        await salaryStatementForExport(
          superAdmin,
          { ...range, employeeId, token: calculation.token },
          now,
        ),
      ).toEqual(calculation);
      await db.attendance.update({
        where: { id: outside.id },
        data: { lateReason: "A change outside this statement range" },
      });
      expect(
        await salaryStatementForExport(
          superAdmin,
          { ...range, employeeId, token: calculation.token },
          now,
        ),
      ).toEqual(calculation);
      const [singleDay] = await calculateSalaries(
        superAdmin,
        { period, from: range.to, to: range.to, employeeIds: [employeeId] },
        now,
      );
      expect(singleDay).toMatchObject({
        baseSalary: "1153.85",
        payableOvertimeMinutes: 75,
        overtimeEarnings: "250.00",
        totalSalary: "1403.85",
      });
      expect(singleDay.attendance).toHaveLength(1);
      const [monthly] = await calculate();
      expect(monthly).toMatchObject({
        from: "2026-09-01",
        to: "2026-09-30",
        payableOvertimeMinutes: 270,
        totalSalary: "26284.62",
      });
      expect(
        await salaryStatementForExport(
          superAdmin,
          { employeeId, period, token: monthly.token },
          now,
        ),
      ).toEqual(monthly);
      expect(
        await salaryStatementForExport(
          superAdmin,
          {
            employeeId,
            period,
            from: "2026-09-01",
            to: "2026-09-30",
            token: monthly.token,
          },
          now,
        ),
      ).toEqual(monthly);
    });

    it("binds custom-range exports to both selected dates even when the resulting totals match", async () => {
      await setting();
      const range = { period, from: "2026-09-06", to: "2026-09-10" };
      const [calculation] = await calculateSalaries(
        superAdmin,
        { ...range, employeeIds: [employeeId] },
        now,
      );
      for (const selected of [
        { period },
        { ...range, from: "2026-09-05" },
        { ...range, to: "2026-09-11" },
      ])
        await expect(
          salaryStatementForExport(
            superAdmin,
            { ...selected, employeeId, token: calculation.token },
            now,
          ),
        ).rejects.toMatchObject({
          code: "SALARY_CALCULATION_INVALID",
          status: 409,
        });
      const [differentRange] = await calculateSalaries(
        superAdmin,
        { ...range, to: "2026-09-11", employeeIds: [employeeId] },
        now,
      );
      expect(differentRange.totalSalary).toBe(calculation.totalSalary);
      expect(differentRange.token).not.toBe(calculation.token);
    });

    it("warns only when the selected current-month range includes dates still in progress in the configured timezone", async () => {
      await setting();
      const past = { period: "2026-10", from: "2026-10-01", to: "2026-10-09" };
      expect(await listing(past)).toMatchObject({
        today: "2026-10-10",
        ongoing: false,
      });
      expect(
        (
          await calculateSalaries(
            superAdmin,
            { ...past, employeeIds: [employeeId] },
            now,
          )
        )[0].ongoing,
      ).toBe(false);
      for (const range of [
        { ...past, to: "2026-10-10" },
        { ...past, from: "2026-10-11", to: "2026-10-31" },
      ]) {
        expect(await listing(range)).toMatchObject({ ongoing: true });
        expect(
          (
            await calculateSalaries(
              superAdmin,
              { ...range, employeeIds: [employeeId] },
              now,
            )
          )[0].ongoing,
        ).toBe(true);
      }
      const endOfMonth = { period, from: "2026-09-30", to: "2026-09-30" };
      expect(
        await listSalaryEmployees(
          superAdmin,
          endOfMonth,
          new Date("2026-09-30T17:30:00Z"),
        ),
      ).toMatchObject({ today: "2026-09-30", ongoing: true });
      expect(
        await listSalaryEmployees(
          superAdmin,
          endOfMonth,
          new Date("2026-09-30T18:30:00Z"),
        ),
      ).toMatchObject({ today: "2026-10-01", ongoing: false });
    });

    it("validates range pairing, calendar dates and monthly salary-rate boundaries on service inputs", async () => {
      await setting();
      for (const range of [
        { period, from: "2026-09-01" },
        { period, to: "2026-09-30" },
        { period, from: "2026-09-15", to: "2026-09-14" },
        { period, from: "2026-08-31", to: "2026-09-01" },
        { period, from: "2026-09-30", to: "2026-10-01" },
        { period, from: "2026-09-01", to: "2026-09-31" },
      ]) {
        await expect(
          listSalaryEmployees(superAdmin, range, now),
        ).rejects.toThrow();
        await expect(
          calculateSalaries(
            superAdmin,
            { ...range, employeeIds: [employeeId] },
            now,
          ),
        ).rejects.toThrow();
        await expect(
          salaryStatementForExport(
            superAdmin,
            { ...range, employeeId, token: "invalid" },
            now,
          ),
        ).rejects.toThrow();
      }
      expect(await db.salarySetting.count()).toBe(1);
      expect(await db.auditLog.count()).toBe(1);
    });

    it("pays nine calendar-based eligible days at monthly reference /26, without excluding leave, holidays, absence or weekend overtime", async () => {
      await setting(period, "18000", "200");
      await db.employeeShift.create({
        data: {
          employeeId,
          shiftId,
          startDate: new Date("2026-09-01T00:00:00Z"),
        },
      });
      await db.leave.create({
        data: {
          employeeId,
          startDate: new Date("2026-09-07T00:00:00Z"),
          endDate: new Date("2026-09-07T00:00:00Z"),
          reason: "Approved leave",
          status: "APPROVED",
        },
      });
      await db.holiday.create({
        data: {
          date: new Date("2026-09-08T00:00:00Z"),
          officeId,
          name: "Office holiday",
        },
      });
      await attendance({
        attendanceDate: new Date("2026-09-11T00:00:00Z"),
        scheduledStartAt: new Date("2026-09-11T03:00:00Z"),
        scheduledEndAt: new Date("2026-09-11T11:30:00Z"),
        checkInAt: new Date("2026-09-11T03:00:00Z"),
        checkOutAt: new Date("2026-09-11T13:00:00Z"),
        status: "PRESENT",
        workedMinutes: 600,
        overtimeMinutes: 90,
      });
      const range = { period, from: "2026-09-06", to: "2026-09-16" };
      const [calculation] = await calculateSalaries(
        superAdmin,
        { ...range, employeeIds: [employeeId] },
        now,
      );
      expect(calculation).toMatchObject({
        monthlyBaseSalary: "18000.00",
        dailyRate: "692.31",
        salaryDivisor: 26,
        calendarDays: 11,
        weekendDays: 2,
        payableDays: 9,
        configuredWeekendDays: [5, 6],
        weekendDates: ["2026-09-11", "2026-09-12"],
        baseSalary: "6230.77",
        payableOvertimeMinutes: 90,
        overtimeEarnings: "300.00",
        totalSalary: "6530.77",
      });
      expect(calculation.attendance).toHaveLength(11);
      expect(
        calculation.attendance.find((row) => row.date === "2026-09-11"),
      ).toMatchObject({ status: "PRESENT", payableOvertimeMinutes: 90 });
      expect(calculation.summary.statusCounts).toMatchObject({
        LEAVE: 1,
        HOLIDAY: 1,
        ABSENT: 7,
      });
      expect(
        await salaryStatementForExport(
          superAdmin,
          { ...range, employeeId, token: calculation.token },
          now,
        ),
      ).toEqual(calculation);
    });

    it("counts non-weekend dates without requiring attendance and supports zero Sunday or empty weekend policies", async () => {
      await setting(period, "18000", "200");
      const range = { period, from: "2026-09-06", to: "2026-09-12" };
      const calculation = async () =>
        (
          await calculateSalaries(
            superAdmin,
            { ...range, employeeIds: [employeeId] },
            now,
          )
        )[0];
      const ordinary = await calculation();
      expect(ordinary).toMatchObject({
        calendarDays: 7,
        weekendDays: 2,
        payableDays: 5,
        baseSalary: "3461.54",
        totalSalary: "3461.54",
        attendance: [],
      });
      await db.office.update({
        where: { id: officeId },
        data: { weekendDays: [0] },
      });
      expect(await calculation()).toMatchObject({
        weekendDays: 1,
        payableDays: 6,
        weekendDates: ["2026-09-06"],
        baseSalary: "4153.85",
      });
      await db.office.update({
        where: { id: officeId },
        data: { weekendDays: [] },
      });
      expect(await calculation()).toMatchObject({
        weekendDays: 0,
        payableDays: 7,
        configuredWeekendDays: [],
        baseSalary: "4846.15",
      });
    });

    it("sets base pay to zero for an all-weekend range while retaining authoritative weekend overtime earnings", async () => {
      await setting(period, "18000", "200");
      await attendance({
        attendanceDate: new Date("2026-09-11T00:00:00Z"),
        scheduledStartAt: new Date("2026-09-11T03:00:00Z"),
        scheduledEndAt: new Date("2026-09-11T11:30:00Z"),
        checkInAt: new Date("2026-09-11T03:00:00Z"),
        checkOutAt: new Date("2026-09-11T12:15:00Z"),
      });
      const [calculation] = await calculateSalaries(
        superAdmin,
        {
          period,
          from: "2026-09-11",
          to: "2026-09-12",
          employeeIds: [employeeId],
        },
        now,
      );
      expect(calculation).toMatchObject({
        calendarDays: 2,
        weekendDays: 2,
        payableDays: 0,
        baseSalary: "0.00",
        payableOvertimeMinutes: 45,
        overtimeEarnings: "150.00",
        totalSalary: "150.00",
      });
    });

    it("invalidates previews after office weekend policy or office identity changes even when totals stay equal", async () => {
      await setting(period, "18000", "200");
      const range = { period, from: "2026-09-06", to: "2026-09-12" };
      const [original] = await calculateSalaries(
        superAdmin,
        { ...range, employeeIds: [employeeId] },
        now,
      );
      await db.office.update({
        where: { id: officeId },
        data: { weekendDays: [0, 1] },
      });
      await expect(
        salaryStatementForExport(
          superAdmin,
          { ...range, employeeId, token: original.token },
          now,
        ),
      ).rejects.toMatchObject({ code: "SALARY_SOURCE_CHANGED" });
      const [updatedPolicy] = await calculateSalaries(
        superAdmin,
        { ...range, employeeIds: [employeeId] },
        now,
      );
      expect(updatedPolicy.totalSalary).toBe(original.totalSalary);
      expect(updatedPolicy.weekendDates).not.toEqual(original.weekendDates);
      const newOffice = await db.office.create({
        data: {
          name: "Salary office",
          address: "Other test office",
          latitude: 0,
          longitude: 0,
          timezone: "Asia/Dhaka",
          weekendDays: [0, 1],
        },
      });
      await db.employee.update({
        where: { id: employeeId },
        data: { officeId: newOffice.id },
      });
      await expect(
        salaryStatementForExport(
          superAdmin,
          { ...range, employeeId, token: updatedPolicy.token },
          now,
        ),
      ).rejects.toMatchObject({ code: "SALARY_SOURCE_CHANGED" });
      const [movedOffice] = await calculateSalaries(
        superAdmin,
        { ...range, employeeIds: [employeeId] },
        now,
      );
      expect(movedOffice.totalSalary).toBe(updatedPolicy.totalSalary);
      expect(movedOffice.employee.officeName).toBe(
        updatedPolicy.employee.officeName,
      );
      expect(movedOffice.configuredWeekendDays).toEqual(
        updatedPolicy.configuredWeekendDays,
      );
    });

    it("rounds exact half-cent range base from stored references before adding the displayed overtime component", async () => {
      await db.office.update({
        where: { id: officeId },
        data: { weekendDays: [] },
      });
      for (const [monthly, expected] of [
        ["0.17", "0.09"],
        ["0.27", "0.14"],
        ["0.53", "0.27"],
        ["9999999999999999.99", "5000000000000000.00"],
      ]) {
        await setting(period, monthly, "0");
        const [calculation] = await calculateSalaries(
          superAdmin,
          {
            period,
            from: "2026-09-01",
            to: "2026-09-13",
            employeeIds: [employeeId],
          },
          now,
        );
        expect(calculation).toMatchObject({
          monthlyBaseSalary: monthly,
          payableDays: 13,
          baseSalary: expected,
          overtimeEarnings: "0.00",
          totalSalary: expected,
        });
      }
    });
  },
);
