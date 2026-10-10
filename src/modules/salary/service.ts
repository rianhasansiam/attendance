import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit/service";
import { countedOvertimeMinutes } from "@/modules/attendance/overtime-policy";
import { initialConfiguration } from "@/modules/daily-expenses/service";
import { assertSuperAdmin, type Actor } from "@/modules/management/permissions";
import { reportRecords, type ReportRecord } from "@/modules/reports/service";
import { shiftDate } from "@/modules/shifts/calculations";
import { calculateSalaryAmounts, countSalaryPayableDays } from "./calculations";
import {
  salaryCalculateInputSchema,
  salaryEmployeeIdSchema,
  salaryExportInputSchema,
  salaryQuerySchema,
  salarySettingsInputSchema,
  type SalaryAttendanceDTO,
  type SalaryCalculateInput,
  type SalaryCalculationDTO,
  type SalaryEmployeeDTO,
  type SalaryEmployeePageDTO,
  type SalaryExportInput,
  type SalaryQuery,
  type SalarySettingsDTO,
  type SalarySettingsInput,
  type SalaryStatementData,
} from "./contracts";
import {
  salarySourceDigest,
  signSalaryVersion,
  verifySalaryVersion,
} from "./version";

const employeeSelect = {
  id: true,
  employeeCode: true,
  user: { select: { name: true, email: true, designation: true } },
  department: { select: { name: true } },
  office: { select: { id: true, name: true, weekendDays: true } },
} satisfies Prisma.EmployeeSelect;
type SalaryEmployee = Prisma.EmployeeGetPayload<{
  select: typeof employeeSelect;
}>;
const settingInclude = {
  createdBy: { select: { id: true, name: true, email: true } },
} satisfies Prisma.SalarySettingInclude;
type Setting = Prisma.SalarySettingGetPayload<{
  include: typeof settingInclude;
}>;

function employeeDTO(employee: SalaryEmployee): SalaryEmployeeDTO {
  return {
    id: employee.id,
    employeeCode: employee.employeeCode,
    name: employee.user.name,
    email: employee.user.email,
    department: employee.department?.name ?? null,
    designation: employee.user.designation,
    officeName: employee.office.name,
  };
}

function settingDTO(setting: Setting): SalarySettingsDTO {
  return {
    id: setting.id,
    effectiveMonth: setting.effectiveMonth.toISOString().slice(0, 7),
    revision: setting.revision,
    baseSalary: setting.baseSalary.toFixed(2),
    overtimeHourlyRate: setting.overtimeHourlyRate.toFixed(2),
    createdAt: setting.createdAt.toISOString(),
    createdBy: setting.createdBy,
  };
}

/** At most one revision per selected employee is retrieved, regardless of history size. */
async function effectiveSettings(employeeIds: string[], period: string) {
  if (!employeeIds.length) return new Map<string, Setting>();
  const winners = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT selected."id"
    FROM "Employee" employee
    JOIN LATERAL (
      SELECT setting."id"
      FROM "SalarySetting" setting
      WHERE setting."employeeId" = employee."id"
        AND setting."effectiveMonth" <= ${`${period}-01`}::date
      ORDER BY setting."effectiveMonth" DESC, setting."revision" DESC
      LIMIT 1
    ) selected ON TRUE
    WHERE employee."id" IN (${Prisma.join(employeeIds)})
  `);
  const settings = winners.length
    ? await db.salarySetting.findMany({
        where: { id: { in: winners.map((winner) => winner.id) } },
        include: settingInclude,
        take: employeeIds.length,
      })
    : [];
  return new Map(
    settings.flatMap((setting) =>
      setting.employeeId ? [[setting.employeeId, setting] as const] : [],
    ),
  );
}

/** There is no salary-read grant in the existing permission model. */
export async function listSalaryEmployees(
  actor: Actor,
  query: SalaryQuery,
  now = new Date(),
): Promise<SalaryEmployeePageDTO> {
  assertSuperAdmin(actor);
  const filters = salaryQuerySchema.parse(query);
  const configuration = initialConfiguration();
  const today = shiftDate(now, configuration.timezone);
  const where: Prisma.EmployeeWhereInput = {
    ...(filters.officeId ? { officeId: filters.officeId } : {}),
    ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
    ...(filters.search
      ? {
          OR: [
            { employeeCode: { contains: filters.search, mode: "insensitive" } },
            {
              user: { name: { contains: filters.search, mode: "insensitive" } },
            },
            {
              user: {
                email: { contains: filters.search, mode: "insensitive" },
              },
            },
          ],
        }
      : {}),
  };
  const [employees, total] = await Promise.all([
    db.employee.findMany({
      where,
      select: employeeSelect,
      orderBy: [{ employeeCode: "asc" }, { id: "asc" }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
    db.employee.count({ where }),
  ]);
  const settings = await effectiveSettings(
    employees.map((employee) => employee.id),
    filters.period,
  );
  return {
    items: employees.map((employee) => ({
      employee: employeeDTO(employee),
      settings: settings.has(employee.id)
        ? settingDTO(settings.get(employee.id)!)
        : null,
    })),
    total,
    page: filters.page,
    pageSize: filters.pageSize,
    totalPages: Math.ceil(total / filters.pageSize),
    period: filters.period,
    from: filters.from,
    to: filters.to,
    today,
    ongoing: filters.period === today.slice(0, 7) && filters.to >= today,
    currentPeriod: today.slice(0, 7),
    ...configuration,
  };
}

export async function saveSalarySettings(
  actor: Actor,
  employeeId: string,
  input: SalarySettingsInput,
): Promise<SalarySettingsDTO> {
  assertSuperAdmin(actor);
  salaryEmployeeIdSchema.parse(employeeId);
  const values = salarySettingsInputSchema.parse(input);
  const effectiveMonth = new Date(`${values.effectiveMonth}-01T00:00:00.000Z`);
  return db.$transaction(async (tx) => {
    // Serialize revision assignment for this employee, including concurrent
    // first-time configuration. A setting update always creates a new row.
    const employees = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id" FROM "Employee" WHERE "id" = ${employeeId} FOR UPDATE`,
    );
    if (!employees.length)
      throw new DomainError("NOT_FOUND", "Employee not found.", 404);
    const previous = await tx.salarySetting.findFirst({
      where: { employeeId, effectiveMonth },
      orderBy: { revision: "desc" },
      include: settingInclude,
    });
    const setting = await tx.salarySetting.create({
      data: {
        employeeId,
        effectiveMonth,
        revision: (previous?.revision ?? 0) + 1,
        baseSalary: new Prisma.Decimal(values.baseSalary),
        overtimeHourlyRate: new Prisma.Decimal(values.overtimeHourlyRate),
        createdById: actor.id,
      },
      include: settingInclude,
    });
    await writeAudit(
      actor.id,
      "SALARY_SETTINGS_REVISED",
      "salary-settings",
      setting.id,
      previous ? { employeeId, ...settingDTO(previous) } : undefined,
      { employeeId, ...settingDTO(setting) },
      tx,
    );
    return settingDTO(setting);
  });
}

function attendanceDTO(record: ReportRecord): SalaryAttendanceDTO {
  return {
    id: record.id,
    date: record.attendanceDate.toISOString().slice(0, 10),
    checkInAt: record.checkInAt?.toISOString() ?? null,
    checkOutAt: record.checkOutAt?.toISOString() ?? null,
    workedMinutes: record.workedMinutes,
    // Keep exactly the shared report policy, including its signed adjustments.
    payableOvertimeMinutes: countedOvertimeMinutes(
      record.overtimeMinutes,
      record.lateMinutes,
      record.checkInAt && record.checkOutAt ? record.workedMinutes : null,
    ),
    status: record.status,
    actualStatus: record.actualStatus,
    lateMinutes: record.lateMinutes,
    effectiveLateMinutes: record.effectiveLateMinutes,
    isExcusedLate: record.isExcusedLate,
    lateApprovalStatus: record.lateApprovalStatus,
    incomplete: Boolean(record.checkInAt && !record.checkOutAt),
    derived: record.derived,
    timezone: record.shift.timezone,
  };
}

type SalarySource = Omit<SalaryCalculationDTO, "generatedAt" | "token"> & {
  reportDigest: string;
  officePolicyDigest: string;
};

function statementSource(source: SalarySource) {
  const statement: Omit<SalaryCalculationDTO, "generatedAt" | "token"> & {
    reportDigest?: string;
    officePolicyDigest?: string;
  } = { ...source };
  delete statement.reportDigest;
  delete statement.officePolicyDigest;
  return statement;
}
async function salarySources(
  actor: Actor,
  input: SalaryCalculateInput,
  now: Date,
): Promise<SalarySource[]> {
  const { period, from, to, employeeIds } =
    salaryCalculateInputSchema.parse(input);
  const configuration = initialConfiguration();
  const today = shiftDate(now, configuration.timezone);
  const [employees, settings, records] = await Promise.all([
    db.employee.findMany({
      where: { id: { in: employeeIds } },
      select: employeeSelect,
      take: employeeIds.length,
    }),
    effectiveSettings(employeeIds, period),
    reportRecords(
      actor,
      { from, to, format: "json", page: 1, pageSize: 100 },
      now,
      employeeIds,
    ),
  ]);
  const byId = new Map(employees.map((employee) => [employee.id, employee]));
  const rows = new Map<string, ReportRecord[]>();
  for (const record of records) {
    if (!record.employee || !byId.has(record.employee.id)) continue;
    const existing = rows.get(record.employee.id) ?? [];
    existing.push(record);
    rows.set(record.employee.id, existing);
  }
  return employeeIds.map((employeeId) => {
    const employee = byId.get(employeeId);
    if (!employee)
      throw new DomainError("NOT_FOUND", "Employee not found.", 404);
    const setting = settings.get(employeeId);
    if (!setting)
      throw new DomainError(
        "SALARY_SETTINGS_MISSING",
        `Salary settings are not configured for ${employee.employeeCode} in ${period}. Configure both amounts and recalculate.`,
        409,
      );
    const report = (rows.get(employeeId) ?? []).sort(
      (a, b) =>
        a.attendanceDate.valueOf() - b.attendanceDate.valueOf() ||
        a.id.localeCompare(b.id),
    );
    const unknownOvertimeRecords = report.filter(
      (record) => record.overtimeMinutes === null,
    ).length;
    if (
      report.some(
        (record) =>
          record.overtimeMinutes === null &&
          record.checkInAt &&
          record.checkOutAt,
      )
    )
      throw new DomainError(
        "SALARY_OVERTIME_UNKNOWN",
        `Completed attendance has unknown overtime for ${employee.employeeCode}. Correct the legacy attendance and recalculate before issuing a statement.`,
        409,
      );
    const attendance = report.map(attendanceDTO);
    const payableOvertimeMinutes = attendance.reduce(
      (total, row) => total + row.payableOvertimeMinutes,
      0,
    );
    const statusCounts: Record<string, number> = {};
    for (const row of attendance)
      statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
    const days = countSalaryPayableDays(from, to, employee.office.weekendDays);
    return {
      reportDigest: salarySourceDigest(report),
      officePolicyDigest: salarySourceDigest(employee.office),
      employee: employeeDTO(employee),
      period,
      from,
      to,
      ...configuration,
      ...days,
      ...calculateSalaryAmounts(
        setting.baseSalary.toFixed(2),
        setting.overtimeHourlyRate.toFixed(2),
        payableOvertimeMinutes,
        days.payableDays,
      ),
      payableOvertimeMinutes,
      ongoing: period === today.slice(0, 7) && to >= today,
      settings: settingDTO(setting),
      attendance,
      summary: {
        workedMinutes: attendance.reduce(
          (total, row) => total + row.workedMinutes,
          0,
        ),
        payableOvertimeMinutes,
        records: attendance.length,
        unknownOvertimeRecords,
        statusCounts,
      },
    };
  });
}

export async function calculateSalaries(
  actor: Actor,
  input: SalaryCalculateInput,
  now = new Date(),
): Promise<SalaryCalculationDTO[]> {
  assertSuperAdmin(actor);
  const sources = await salarySources(actor, input, now);
  const generatedAt = now.toISOString();
  return sources.map((source) => ({
    ...statementSource(source),
    generatedAt,
    token: signSalaryVersion({
      actorId: actor.id,
      employeeId: source.employee.id,
      period: source.period,
      from: source.from,
      to: source.to,
      generatedAt,
      sourceDigest: salarySourceDigest(source),
    }),
  }));
}

export async function salaryStatementForExport(
  actor: Actor,
  input: SalaryExportInput,
  now = new Date(),
): Promise<SalaryStatementData> {
  assertSuperAdmin(actor);
  const { employeeId, period, from, to, token } =
    salaryExportInputSchema.parse(input);
  const version = verifySalaryVersion(token, now);
  if (
    version.actorId !== actor.id ||
    version.employeeId !== employeeId ||
    version.period !== period ||
    version.from !== from ||
    version.to !== to
  )
    throw new DomainError(
      "SALARY_CALCULATION_INVALID",
      "Calculate this employee's salary for the selected dates before downloading.",
      409,
    );
  const [source] = await salarySources(
    actor,
    { period, from, to, employeeIds: [employeeId] },
    now,
  );
  if (salarySourceDigest(source) !== version.sourceDigest)
    throw new DomainError(
      "SALARY_SOURCE_CHANGED",
      "Salary settings, attendance, or office weekend policy changed after this calculation. Recalculate before downloading.",
      409,
    );
  return {
    ...statementSource(source),
    generatedAt: version.generatedAt,
    token,
  };
}
