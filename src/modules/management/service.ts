import { z } from "zod";
import { db } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { driveCostWhere } from "@/modules/drive-costs/filters";
import {
  createEmployee,
  employeeInclude,
  publicUserSelect,
  updateEmployee,
} from "@/modules/employees/service";
import {
  removeCatalogRecord,
  saveAssignment,
  saveDepartment,
  saveDriveCost,
  saveHoliday,
  saveNetwork,
  saveOffice,
  saveShift,
} from "./catalog";
import { assertSuperAdmin, type Actor } from "./permissions";
import {
  createAdministrator,
  deviceSelect,
  reviewLeave,
  saveSetting,
  updateDevice,
  updateUser,
} from "./workflows";
import {
  deviceUpdateSchema,
  driveCostFilterSchema,
  employeeSchema,
  employeeUpdateSchema,
  leaveReviewSchema,
  userSchema,
  userUpdateSchema,
  utcDate,
} from "./validation";

export const resourceSchema = z.enum([
  "employees",
  "departments",
  "offices",
  "networks",
  "shifts",
  "assignments",
  "devices",
  "leaves",
  "holidays",
  "drive-costs",
  "users",
  "settings",
  "audit",
  "events",
]);
type Resource = z.infer<typeof resourceSchema>;
const employeeName = (q?: string) =>
  q
    ? {
        user: {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { email: { contains: q, mode: "insensitive" as const } },
          ],
        },
      }
    : {};

export async function listRecords(
  actor: Actor,
  resource: Resource,
  query: z.infer<typeof driveCostFilterSchema>,
) {
  if (resource === "users" || resource === "settings") assertSuperAdmin(actor);
  const { page, pageSize, q } = query;
  const window = { take: pageSize, skip: (page - 1) * pageSize };
  const named = q
    ? { name: { contains: q, mode: "insensitive" as const } }
    : {};
  let result: [unknown[], number];
  switch (resource) {
    case "employees": {
      const where = q
        ? {
            OR: [
              { employeeCode: { contains: q, mode: "insensitive" as const } },
              employeeName(q),
            ],
          }
        : {};
      result = await Promise.all([
        db.employee.findMany({
          where,
          include: employeeInclude,
          orderBy: { employeeCode: "asc" },
          ...window,
        }),
        db.employee.count({ where }),
      ]);
      break;
    }
    case "departments":
      result = await Promise.all([
        db.department.findMany({
          where: named,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          ...window,
        }),
        db.department.count({ where: named }),
      ]);
      break;
    case "offices":
      result = await Promise.all([
        db.office.findMany({
          where: named,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          ...window,
        }),
        db.office.count({ where: named }),
      ]);
      break;
    case "networks": {
      const where = q
        ? { OR: [{ publicIpOrCidr: { contains: q } }, { office: named }] }
        : {};
      result = await Promise.all([
        db.officeNetwork.findMany({
          where,
          include: { office: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          ...window,
        }),
        db.officeNetwork.count({ where }),
      ]);
      break;
    }
    case "shifts":
      result = await Promise.all([
        db.shift.findMany({
          where: named,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          ...window,
        }),
        db.shift.count({ where: named }),
      ]);
      break;
    case "assignments": {
      const where = q ? { employee: employeeName(q) } : {};
      result = await Promise.all([
        db.employeeShift.findMany({
          where,
          include: { employee: { include: employeeInclude }, shift: true },
          orderBy: [{ startDate: "desc" }, { id: "desc" }],
          ...window,
        }),
        db.employeeShift.count({ where }),
      ]);
      break;
    }
    case "devices": {
      const where = q ? { employee: employeeName(q) } : {};
      result = await Promise.all([
        db.webAuthnCredential.findMany({
          where,
          select: deviceSelect,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          ...window,
        }),
        db.webAuthnCredential.count({ where }),
      ]);
      break;
    }
    case "leaves": {
      const where = q ? { employee: employeeName(q) } : {};
      result = await Promise.all([
        db.leave.findMany({
          where,
          include: { employee: { include: employeeInclude } },
          orderBy: [{ status: "asc" }, { createdAt: "desc" }, { id: "desc" }],
          ...window,
        }),
        db.leave.count({ where }),
      ]);
      break;
    }
    case "holidays":
      result = await Promise.all([
        db.holiday.findMany({
          where: named,
          include: { office: true },
          orderBy: [{ date: "desc" }, { id: "desc" }],
          ...window,
        }),
        db.holiday.count({ where: named }),
      ]);
      break;
    case "drive-costs": {
      const where = driveCostWhere(query);
      result = await Promise.all([
        db.driveCost.findMany({
          where,
          orderBy: [{ date: "desc" }, { id: "desc" }],
          ...window,
        }),
        db.driveCost.count({ where }),
      ]);
      break;
    }
    case "users": {
      const where = q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" as const } },
              { email: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {};
      result = await Promise.all([
        db.user.findMany({
          where,
          select: publicUserSelect,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          ...window,
        }),
        db.user.count({ where }),
      ]);
      break;
    }
    case "settings":
      result = await Promise.all([
        db.systemSetting.findMany({ orderBy: { key: "asc" }, ...window }),
        db.systemSetting.count(),
      ]);
      break;
    case "audit": {
      const where = q
        ? {
            OR: [
              { action: { contains: q, mode: "insensitive" as const } },
              { resource: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {};
      result = await Promise.all([
        db.auditLog.findMany({
          where,
          include: { actor: { select: publicUserSelect } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          ...window,
        }),
        db.auditLog.count({ where }),
      ]);
      break;
    }
    case "events": {
      const where = q
        ? {
            OR: [
              { type: { contains: q, mode: "insensitive" as const } },
              { reason: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {};
      result = await Promise.all([
        db.attendanceEvent.findMany({
          where,
          include: { employee: { include: employeeInclude } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          ...window,
        }),
        db.attendanceEvent.count({ where }),
      ]);
      break;
    }
  }
  return { items: result[0], total: result[1], page, pageSize };
}

export async function getRecord(actor: Actor, resource: Resource, id: string) {
  if (resource === "users" || resource === "settings") assertSuperAdmin(actor);
  let record: unknown;
  switch (resource) {
    case "employees":
      record = await db.employee.findUnique({
        where: { id },
        include: {
          ...employeeInclude,
          shifts: { include: { shift: true } },
          credentials: { select: deviceSelect },
        },
      });
      break;
    case "departments":
      record = await db.department.findUnique({ where: { id } });
      break;
    case "offices":
      record = await db.office.findUnique({
        where: { id },
        include: { networks: true },
      });
      break;
    case "networks":
      record = await db.officeNetwork.findUnique({
        where: { id },
        include: { office: true },
      });
      break;
    case "shifts":
      record = await db.shift.findUnique({ where: { id } });
      break;
    case "assignments":
      record = await db.employeeShift.findUnique({
        where: { id },
        include: { employee: { include: employeeInclude }, shift: true },
      });
      break;
    case "devices":
      record = await db.webAuthnCredential.findUnique({
        where: { id },
        select: deviceSelect,
      });
      break;
    case "leaves":
      record = await db.leave.findUnique({
        where: { id },
        include: { employee: { include: employeeInclude } },
      });
      break;
    case "holidays":
      record = await db.holiday.findUnique({
        where: { id },
        include: { office: true },
      });
      break;
    case "drive-costs":
      record = await db.driveCost.findUnique({ where: { id } });
      break;
    case "users":
      record = await db.user.findUnique({
        where: { id },
        select: publicUserSelect,
      });
      break;
    case "settings":
      record = await db.systemSetting.findUnique({ where: { key: id } });
      break;
    case "audit":
      record = await db.auditLog.findUnique({
        where: { id },
        include: { actor: { select: publicUserSelect } },
      });
      break;
    case "events":
      record = await db.attendanceEvent.findUnique({ where: { id } });
      break;
  }
  if (!record) throw new DomainError("NOT_FOUND", "Record not found.", 404);
  return record;
}

export async function createRecord(
  actor: Actor,
  resource: Resource,
  body: unknown,
) {
  switch (resource) {
    case "employees":
      return createEmployee(actor, employeeSchema.parse(body));
    case "departments":
      return saveDepartment(actor, body);
    case "offices":
      return saveOffice(actor, body);
    case "networks":
      return saveNetwork(actor, body);
    case "shifts":
      return saveShift(actor, body);
    case "assignments":
      return saveAssignment(actor, body);
    case "holidays":
      return saveHoliday(actor, body);
    case "drive-costs":
      return saveDriveCost(actor, body);
    case "users":
      return createAdministrator(actor, userSchema.parse(body));
    case "settings":
      return saveSetting(actor, body);
    default:
      throw new DomainError(
        "METHOD_NOT_ALLOWED",
        "This resource cannot be created here.",
        405,
      );
  }
}

export async function updateRecord(
  actor: Actor,
  resource: Resource,
  id: string,
  body: unknown,
) {
  switch (resource) {
    case "employees":
      return updateEmployee(actor, id, employeeUpdateSchema.parse(body));
    case "departments":
      return saveDepartment(actor, body, id);
    case "offices":
      return saveOffice(actor, body, id);
    case "networks":
      return saveNetwork(actor, body, id);
    case "shifts":
      return saveShift(actor, body, id);
    case "assignments":
      return saveAssignment(actor, body, id);
    case "holidays":
      return saveHoliday(actor, body, id);
    case "drive-costs":
      return saveDriveCost(actor, body, id);
    case "devices":
      return updateDevice(actor, id, deviceUpdateSchema.parse(body));
    case "leaves":
      return reviewLeave(actor, id, leaveReviewSchema.parse(body));
    case "users":
      return updateUser(actor, id, userUpdateSchema.parse(body));
    case "settings":
      return saveSetting(actor, {
        key: id,
        ...z.object({ value: z.unknown() }).strict().parse(body),
      });
    default:
      throw new DomainError(
        "METHOD_NOT_ALLOWED",
        "This resource cannot be edited.",
        405,
      );
  }
}

export async function removeRecord(
  actor: Actor,
  resource: Resource,
  id: string,
) {
  if (resource === "employees")
    return updateEmployee(actor, id, { status: "INACTIVE" });
  if (resource === "devices") return updateDevice(actor, id, { revoked: true });
  if (resource === "users")
    return updateUser(actor, id, { status: "INACTIVE" });
  return removeCatalogRecord(actor, resource, id);
}
