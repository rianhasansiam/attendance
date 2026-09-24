import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit/service";
import { calculateDriveCost } from "@/modules/drive-costs/calculations";
import { assertSuperAdmin, type Actor } from "./permissions";
import {
  assignmentSchema,
  departmentSchema,
  driveCostSchema,
  driveCostUpdateSchema,
  holidaySchema,
  networkSchema,
  officeSchema,
  policySchema,
  shiftSchema,
  utcDate,
} from "./validation";

const missing = () =>
  new DomainError("NOT_FOUND", "The requested record was not found.", 404);

export async function saveDepartment(actor: Actor, raw: unknown, id?: string) {
  const input = id
    ? departmentSchema.partial().parse(raw)
    : departmentSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const previous = id
      ? await tx.department.findUnique({ where: { id } })
      : null;
    if (id && !previous) throw missing();
    const result = id
      ? await tx.department.update({ where: { id }, data: input })
      : await tx.department.create({ data: departmentSchema.parse(input) });
    await writeAudit(
      actor.id,
      id ? "DEPARTMENT_UPDATED" : "DEPARTMENT_CREATED",
      "Department",
      result.id,
      previous ?? undefined,
      result,
      tx,
    );
    return result;
  });
}

export async function getOfficePolicyDefaults() {
  const setting = await db.systemSetting.findUnique({
    where: { key: "attendance.defaultPolicy" },
  });
  return policySchema.parse(
    setting?.value ?? {
      requireWebAuthn: true,
      requireGeofence: true,
      requireOfficeNetwork: true,
      requireApprovedDevice: true,
      maximumGpsAccuracyMeters: 50,
    },
  );
}

export async function saveOffice(actor: Actor, raw: unknown, id?: string) {
  const defaults = id ? {} : await getOfficePolicyDefaults();
  const input = id
    ? officeSchema.partial().parse(raw)
    : officeSchema.parse({ ...defaults, ...zObject(raw) });
  return db.$transaction(async (tx) => {
    const previous = id ? await tx.office.findUnique({ where: { id } }) : null;
    if (id && !previous) throw missing();
    const result = id
      ? await tx.office.update({ where: { id }, data: input })
      : await tx.office.create({ data: officeSchema.parse(input) });
    await writeAudit(
      actor.id,
      id ? "OFFICE_UPDATED" : "OFFICE_CREATED",
      "Office",
      result.id,
      previous ?? undefined,
      result,
      tx,
    );
    if (
      previous &&
      [
        "requireWebAuthn",
        "requireGeofence",
        "requireOfficeNetwork",
        "requireApprovedDevice",
        "maximumGpsAccuracyMeters",
      ].some(
        (key) =>
          previous[key as keyof typeof previous] !==
          result[key as keyof typeof result],
      )
    ) {
      await writeAudit(
        actor.id,
        "ATTENDANCE_POLICY_MODIFIED",
        "Office",
        result.id,
        previous,
        result,
        tx,
      );
    }
    return result;
  });
}

function zObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new DomainError("INVALID_INPUT", "An object is required.");
  return raw as Record<string, unknown>;
}

export async function saveNetwork(actor: Actor, raw: unknown, id?: string) {
  const input = id
    ? networkSchema.partial().parse(raw)
    : networkSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const previous = id
      ? await tx.officeNetwork.findUnique({ where: { id } })
      : null;
    if (id && !previous) throw missing();
    if (
      input.officeId &&
      !(await tx.office.findUnique({ where: { id: input.officeId } }))
    )
      throw new DomainError("OFFICE_UNAVAILABLE", "Office not found.");
    const result = id
      ? await tx.officeNetwork.update({ where: { id }, data: input })
      : await tx.officeNetwork.create({ data: networkSchema.parse(input) });
    await writeAudit(
      actor.id,
      id ? "NETWORK_UPDATED" : "NETWORK_CREATED",
      "OfficeNetwork",
      result.id,
      previous ?? undefined,
      result,
      tx,
    );
    return result;
  });
}

export async function saveShift(actor: Actor, raw: unknown, id?: string) {
  return db.$transaction(async (tx) => {
    const previous = id ? await tx.shift.findUnique({ where: { id } }) : null;
    if (id && !previous) throw missing();
    const fields = previous
      ? {
          name: previous.name,
          startTime: previous.startTime,
          endTime: previous.endTime,
          graceMinutes: previous.graceMinutes,
          halfDayThreshold: previous.halfDayThreshold,
          timezone: previous.timezone,
          active: previous.active,
        }
      : {};
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new DomainError("INVALID_INPUT", "An object is required.");
    const input = shiftSchema.parse({ ...fields, ...raw });
    const result = id
      ? await tx.shift.update({ where: { id }, data: input })
      : await tx.shift.create({ data: input });
    await writeAudit(
      actor.id,
      id ? "SHIFT_UPDATED" : "SHIFT_CREATED",
      "Shift",
      result.id,
      previous ?? undefined,
      result,
      tx,
    );
    return result;
  });
}

export async function saveAssignment(actor: Actor, raw: unknown, id?: string) {
  const input = assignmentSchema.parse(raw);
  const startDate = utcDate(input.startDate);
  const endDate = input.endDate ? utcDate(input.endDate) : null;
  return db.$transaction(
    async (tx) => {
      const previous = id
        ? await tx.employeeShift.findUnique({ where: { id } })
        : null;
      if (id && !previous) throw missing();
      const employee = await tx.employee.findUnique({
        where: { id: input.employeeId },
        include: { user: true },
      });
      const shift = await tx.shift.findUnique({ where: { id: input.shiftId } });
      if (!employee || employee.user.status !== "ACTIVE")
        throw new DomainError(
          "EMPLOYEE_UNAVAILABLE",
          "Choose an active employee.",
        );
      if (!shift?.active)
        throw new DomainError("SHIFT_UNAVAILABLE", "Choose an active shift.");
      const overlap = await tx.employeeShift.findFirst({
        where: {
          employeeId: input.employeeId,
          ...(id ? { id: { not: id } } : {}),
          ...(endDate ? { startDate: { lte: endDate } } : {}),
          OR: [{ endDate: null }, { endDate: { gte: startDate } }],
        },
      });
      if (overlap)
        throw new DomainError(
          "OVERLAPPING_SHIFT",
          "This employee already has a shift during this date range.",
          409,
        );
      const data = {
        employeeId: input.employeeId,
        shiftId: input.shiftId,
        startDate,
        endDate,
      };
      const result = id
        ? await tx.employeeShift.update({ where: { id }, data })
        : await tx.employeeShift.create({ data });
      await writeAudit(
        actor.id,
        "SHIFT_ASSIGNED",
        "EmployeeShift",
        result.id,
        previous ?? undefined,
        result,
        tx,
      );
      return result;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function saveHoliday(actor: Actor, raw: unknown, id?: string) {
  const input = holidaySchema.parse(raw);
  const data = {
    name: input.name,
    date: utcDate(input.date),
    officeId: input.officeId || null,
  };
  return db.$transaction(
    async (tx) => {
      const previous = id
        ? await tx.holiday.findUnique({ where: { id } })
        : null;
      if (id && !previous) throw missing();
      if (
        await tx.holiday.findFirst({
          where: {
            date: data.date,
            officeId: data.officeId,
            ...(id ? { id: { not: id } } : {}),
          },
        })
      )
        throw new DomainError(
          "DUPLICATE_HOLIDAY",
          "A holiday already exists for this office and date.",
          409,
        );
      const result = id
        ? await tx.holiday.update({ where: { id }, data })
        : await tx.holiday.create({ data });
      await writeAudit(
        actor.id,
        id ? "HOLIDAY_UPDATED" : "HOLIDAY_CREATED",
        "Holiday",
        result.id,
        previous ?? undefined,
        result,
        tx,
      );
      return result;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function saveDriveCost(actor: Actor, raw: unknown, id?: string) {
  const input = (id ? driveCostUpdateSchema : driveCostSchema).parse(raw);
  if (input.paymentStatus !== undefined) assertSuperAdmin(actor);
  const data =
    "date" in input
      ? driveCostData(input)
      : { paymentStatus: input.paymentStatus };

  return db.$transaction(async (tx) => {
    const previous = id
      ? await tx.driveCost.findUnique({ where: { id } })
      : null;
    if (id && !previous) throw missing();
    const result = id
      ? await tx.driveCost.update({ where: { id }, data })
      : await tx.driveCost.create({
          data: {
            ...driveCostData(driveCostSchema.parse(raw)),
            createdById: actor.id,
          },
        });
    await writeAudit(
      actor.id,
      id ? "DRIVE_COST_UPDATED" : "DRIVE_COST_CREATED",
      "DriveCost",
      result.id,
      previous ?? undefined,
      result,
      tx,
    );
    return result;
  });
}

function driveCostData(input: ReturnType<typeof driveCostSchema.parse>) {
  return {
    date: utcDate(input.date),
    destinationFrom: input.destinationFrom,
    destinationTo: input.destinationTo,
    isRoundTrip: input.isRoundTrip,
    rateType: input.rateType,
    ...calculateDriveCost(input.kilometers, input.rateType, input.isRoundTrip),
    ...(input.paymentStatus !== undefined
      ? { paymentStatus: input.paymentStatus }
      : {}),
  };
}

export async function removeCatalogRecord(
  actor: Actor,
  resource: string,
  id: string,
) {
  return db.$transaction(async (tx) => {
    let previous: unknown;
    switch (resource) {
      case "departments":
        previous = await tx.department.findUniqueOrThrow({ where: { id } });
        await tx.department.update({ where: { id }, data: { active: false } });
        break;
      case "offices":
        previous = await tx.office.findUniqueOrThrow({ where: { id } });
        await tx.office.update({ where: { id }, data: { active: false } });
        break;
      case "networks":
        previous = await tx.officeNetwork.findUniqueOrThrow({ where: { id } });
        await tx.officeNetwork.update({
          where: { id },
          data: { active: false },
        });
        break;
      case "shifts":
        previous = await tx.shift.findUniqueOrThrow({ where: { id } });
        await tx.shift.update({ where: { id }, data: { active: false } });
        break;
      case "assignments":
        previous = await tx.employeeShift.delete({ where: { id } });
        break;
      case "holidays":
        previous = await tx.holiday.delete({ where: { id } });
        break;
      case "drive-costs":
        previous = await tx.driveCost.delete({ where: { id } });
        break;
      default:
        throw new DomainError(
          "METHOD_NOT_ALLOWED",
          "This record cannot be deleted.",
          405,
        );
    }
    await writeAudit(
      actor.id,
      resource === "drive-costs" ? "DRIVE_COST_DELETED" : "RECORD_REMOVED",
      resource === "drive-costs" ? "DriveCost" : resource,
      id,
      previous,
      undefined,
      tx,
    );
    return { id };
  });
}
