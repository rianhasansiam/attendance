import "server-only";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit/service";
import {
  officeWorkActionSchema,
  officeWorkActivityQuerySchema,
  officeWorkAssigneesQuerySchema,
  officeWorkCreateSchema,
  officeWorkIdSchema,
  officeWorkListSchema,
  officeWorkUpdateSchema,
  type OfficeWorkActivityDTO,
  type OfficeWorkActor,
  type OfficeWorkDashboardDTO,
  type OfficeWorkDetailDTO,
  type OfficeWorkFilters,
  type OfficeWorkOverviewDTO,
  type OfficeWorkPerson,
  type OfficeWorkTaskDTO,
  type OfficeWorkWorkloadDTO,
} from "./contracts";
import {
  authorizeOfficeWork,
  canAssignOfficeWorkRole,
  canCreateOfficeWork,
  taskPermissions,
  visibilityWhere,
} from "./permissions";
import {
  isOfficeWorkOverdue,
  officeWorkConflict,
  officeWorkTimezone,
  todayInTimezone,
  transitionPatch,
} from "./policy";
import {
  officeWorkBaseWhere,
  officeWorkListWhere,
  officeWorkOrderBy,
  officeWorkOverdueWhere,
} from "./filters";

const personSelect = { id: true, name: true, email: true, role: true } as const;
const taskInclude = {
  assignee: { select: personSelect },
  createdBy: { select: personSelect },
} satisfies Prisma.OfficeWorkTaskInclude;
type TaskRecord = Prisma.OfficeWorkTaskGetPayload<{
  include: typeof taskInclude;
}>;
type Tx = Prisma.TransactionClient;
type CurrentAccount = { id: string; role: string; status: string };

async function currentAccount(
  tx: Tx,
  id: string,
  lock = false,
): Promise<CurrentAccount | null> {
  if (lock) {
    const [record] = await tx.$queryRaw<CurrentAccount[]>`
      SELECT "id", "role", "status" FROM "User" WHERE "id" = ${id} FOR SHARE
    `;
    return record ?? null;
  }
  return tx.user.findUnique({
    where: { id },
    select: { id: true, role: true, status: true },
  });
}
async function currentActor(
  tx: Tx,
  actor: OfficeWorkActor,
  lock: boolean,
): Promise<CurrentAccount> {
  const current = actor.id ? await currentAccount(tx, actor.id, lock) : null;
  if (!current)
    throw new DomainError(
      "FORBIDDEN",
      "You do not have access to Office Work.",
      403,
    );
  authorizeOfficeWork(current);
  return current;
}
function read<T>(
  actor: OfficeWorkActor,
  operation: (tx: Tx, current: CurrentAccount) => Promise<T>,
): Promise<T> {
  return db.$transaction(
    async (tx) => operation(tx, await currentActor(tx, actor, false)),
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    },
  );
}
function isDatabaseConflict(error: unknown): boolean {
  const queue: unknown[] = [error];
  for (let index = 0; index < queue.length && index < 20; index++) {
    const value = queue[index];
    if (!value || typeof value !== "object") continue;
    const fields = value as Record<string, unknown>;
    if (
      [fields.code, fields.sqlState, fields.originalCode].some(
        (code) => code === "P2034" || code === "40P01" || code === "40001",
      )
    )
      return true;
    queue.push(fields.cause, fields.meta, fields.driverAdapterError);
  }
  return false;
}
async function write<T>(
  actor: OfficeWorkActor,
  operation: (tx: Tx, current: CurrentAccount) => Promise<T>,
): Promise<T> {
  try {
    return await db.$transaction(
      async (tx) => operation(tx, await currentActor(tx, actor, true)),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10000,
        timeout: 15000,
      },
    );
  } catch (error) {
    if (isDatabaseConflict(error)) throw officeWorkConflict();
    throw error;
  }
}
function taskDTO(
  record: TaskRecord,
  actor: OfficeWorkActor,
  today: string,
): OfficeWorkTaskDTO {
  const dueDate = record.dueDate?.toISOString().slice(0, 10) ?? null;
  return {
    id: record.id,
    version: record.version,
    title: record.title,
    description: record.description,
    status: record.status,
    priority: record.priority,
    assigneeId: record.assigneeId,
    createdById: record.createdById,
    assignee: record.assignee,
    createdBy: record.createdBy,
    dueDate,
    startedAt: record.startedAt?.toISOString() ?? null,
    completedAt: record.completedAt?.toISOString() ?? null,
    archivedAt: record.archivedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    overdue: isOfficeWorkOverdue({ ...record, dueDate }, today),
    permissions: taskPermissions(actor, record),
  };
}
function snapshot(task: TaskRecord): Prisma.InputJsonObject {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    assigneeId: task.assigneeId,
    assignee: task.assignee
      ? {
          id: task.assignee.id,
          name: task.assignee.name,
          role: task.assignee.role,
        }
      : null,
    createdById: task.createdById,
    dueDate: task.dueDate?.toISOString().slice(0, 10) ?? null,
    startedAt: task.startedAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    archivedAt: task.archivedAt?.toISOString() ?? null,
    version: task.version,
  };
}
async function recordActivity(
  tx: Tx,
  actor: OfficeWorkActor,
  action: string,
  task: TaskRecord,
  before?: TaskRecord,
  reason?: string,
  workUpdate?: string,
) {
  await writeAudit(
    actor.id,
    action,
    "OfficeWorkTask",
    task.id,
    before ? snapshot(before) : undefined,
    {
      ...snapshot(task),
      ...(reason ? { reason } : {}),
      ...(workUpdate ? { workUpdate } : {}),
    },
    tx,
  );
}
function jsonObject(
  value: Prisma.JsonValue | null,
): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}
function activityDTO(
  record: Prisma.AuditLogGetPayload<{
    include: { actor: { select: typeof personSelect } };
  }>,
): OfficeWorkActivityDTO {
  const after = jsonObject(record.newState);
  return {
    id: record.id,
    action: record.action,
    actor: record.actor,
    before: jsonObject(record.previousState),
    after,
    reason: typeof after?.reason === "string" ? after.reason : null,
    update: typeof after?.workUpdate === "string" ? after.workUpdate : null,
    createdAt: record.createdAt.toISOString(),
  };
}
async function dashboard(
  tx: Tx,
  actor: OfficeWorkActor,
  filters: OfficeWorkFilters,
  today: string,
): Promise<OfficeWorkDashboardDTO> {
  const base = officeWorkBaseWhere(actor, filters, true);
  const [groups, overdue, dueToday, highPriority] = await Promise.all([
    tx.officeWorkTask.groupBy({
      by: ["status"],
      where: base,
      _count: { _all: true },
    }),
    tx.officeWorkTask.count({
      where: { AND: [base, officeWorkOverdueWhere(today)] },
    }),
    tx.officeWorkTask.count({
      where: {
        AND: [
          base,
          {
            status: { not: "DONE" },
            dueDate: new Date(`${today}T00:00:00.000Z`),
          },
        ],
      },
    }),
    tx.officeWorkTask.count({
      where: { AND: [base, { status: { not: "DONE" }, priority: "HIGH" }] },
    }),
  ]);
  const count = (status: string) =>
    groups.find((entry) => entry.status === status)?._count._all ?? 0;
  const pending = count("PENDING"),
    processing = count("PROCESSING"),
    done = count("DONE");
  const total = pending + processing + done;
  return {
    total,
    pending,
    processing,
    done,
    overdue,
    dueToday,
    highPriority,
    completionPercent: total ? Math.round((done / total) * 1000) / 10 : 0,
  };
}
async function workload(
  tx: Tx,
  actor: OfficeWorkActor,
  filters: OfficeWorkFilters,
  today: string,
): Promise<OfficeWorkWorkloadDTO[]> {
  if (actor.role === "EMPLOYEE") return [];
  const base = officeWorkBaseWhere(actor, filters, true);
  const [groups, overdueGroups] = await Promise.all([
    tx.officeWorkTask.groupBy({
      by: ["assigneeId", "status"],
      where: base,
      _count: { _all: true },
    }),
    tx.officeWorkTask.groupBy({
      by: ["assigneeId"],
      where: { AND: [base, officeWorkOverdueWhere(today)] },
      _count: { _all: true },
    }),
  ]);
  const ids = [
    ...new Set(
      groups.flatMap((group) => (group.assigneeId ? [group.assigneeId] : [])),
    ),
  ];
  const people = ids.length
    ? await tx.user.findMany({
        where: { id: { in: ids } },
        select: personSelect,
      })
    : [];
  const rows = new Map<string | null, OfficeWorkWorkloadDTO>();
  for (const group of groups) {
    const row = rows.get(group.assigneeId) ?? {
      assignee: people.find((person) => person.id === group.assigneeId) ?? null,
      pending: 0,
      processing: 0,
      done: 0,
      overdue:
        overdueGroups.find((entry) => entry.assigneeId === group.assigneeId)
          ?._count._all ?? 0,
    };
    if (group.status === "PENDING") row.pending = group._count._all;
    else if (group.status === "PROCESSING") row.processing = group._count._all;
    else row.done = group._count._all;
    rows.set(group.assigneeId, row);
  }
  return [...rows.values()].sort(
    (a, b) =>
      (a.assignee?.name ?? a.assignee?.email ?? "").localeCompare(
        b.assignee?.name ?? b.assignee?.email ?? "",
      ) || (a.assignee?.id ?? "").localeCompare(b.assignee?.id ?? ""),
  );
}
export async function getOfficeWorkOverview(
  actor: OfficeWorkActor,
  raw: unknown = {},
): Promise<OfficeWorkOverviewDTO> {
  const filters = officeWorkListSchema.parse(raw);
  return read(actor, async (tx, current) => {
    const timezone = officeWorkTimezone(),
      today = todayInTimezone(timezone);
    const where = officeWorkListWhere(current, filters, today);
    const total = await tx.officeWorkTask.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
    const page = Math.min(filters.page, totalPages);
    const [items, summary, rows, creators, assignees] = await Promise.all([
      tx.officeWorkTask.findMany({
        where,
        include: taskInclude,
        orderBy: officeWorkOrderBy(filters.sort),
        skip: (page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      dashboard(tx, current, filters, today),
      workload(tx, current, filters, today),
      current.role === "EMPLOYEE"
        ? []
        : tx.user.findMany({
            where: { createdOfficeWork: { some: visibilityWhere(current) } },
            select: personSelect,
            orderBy: [{ name: "asc" }, { id: "asc" }],
          }),
      current.role === "EMPLOYEE"
        ? []
        : tx.user.findMany({
            where: { assignedOfficeWork: { some: visibilityWhere(current) } },
            select: personSelect,
            orderBy: [{ name: "asc" }, { id: "asc" }],
          }),
    ]);
    return {
      items: items.map((item) => taskDTO(item, current, today)),
      total,
      page,
      pageSize: filters.pageSize,
      totalPages,
      dashboard: summary,
      workload: rows,
      creators,
      assignees,
      today,
      timezone,
    };
  });
}
export async function getOfficeWorkTask(
  actor: OfficeWorkActor,
  rawId: string,
  rawActivityQuery: unknown = {},
): Promise<OfficeWorkDetailDTO> {
  const id = officeWorkIdSchema.parse(rawId),
    query = officeWorkActivityQuerySchema.parse(rawActivityQuery);
  return read(actor, async (tx, current) => {
    const record = await tx.officeWorkTask.findFirst({
      where: { AND: [{ id }, visibilityWhere(current)] },
      include: taskInclude,
    });
    if (!record)
      throw new DomainError(
        "NOT_FOUND",
        "The requested task was not found.",
        404,
      );
    const where = { resource: "OfficeWorkTask", resourceId: id };
    const activityTotal = await tx.auditLog.count({ where });
    const page = Math.min(
      query.page,
      Math.max(1, Math.ceil(activityTotal / query.pageSize)),
    );
    const activities = await tx.auditLog.findMany({
      where,
      include: { actor: { select: personSelect } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * query.pageSize,
      take: query.pageSize,
    });
    return {
      task: taskDTO(record, current, todayInTimezone(officeWorkTimezone())),
      activities: activities.map(activityDTO),
      activityPage: page,
      activityPageSize: query.pageSize,
      activityTotal,
    };
  });
}
export async function listOfficeWorkAssignees(
  actor: OfficeWorkActor,
  raw: unknown = {},
): Promise<OfficeWorkPerson[]> {
  const { search } = officeWorkAssigneesQuerySchema.parse(raw);
  return read(actor, async (tx, current) => {
    if (!canCreateOfficeWork(current.role))
      throw new DomainError(
        "FORBIDDEN",
        "Only task creators can look up assignees.",
        403,
      );
    const contains = search?.replace(/[\\%_]/g, "\\$&");
    return tx.user.findMany({
      where: {
        status: "ACTIVE",
        role:
          current.role === "SUPER_ADMIN"
            ? { in: ["EMPLOYEE", "MANAGE_DRIVER"] }
            : "EMPLOYEE",
        ...(contains
          ? {
              OR: [
                { name: { contains, mode: "insensitive" } },
                { email: { contains, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      select: personSelect,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: 100,
    });
  });
}
async function eligibleAssignee(tx: Tx, actor: OfficeWorkActor, id: string) {
  const assignee = await currentAccount(tx, id, true);
  if (
    !assignee ||
    assignee.status !== "ACTIVE" ||
    !canAssignOfficeWorkRole(actor.role, assignee.role)
  )
    throw new DomainError(
      "INVALID_ASSIGNEE",
      "Choose an active assignee allowed for your role.",
    );
}
async function lockedTask(
  tx: Tx,
  actor: OfficeWorkActor,
  id: string,
  expectedVersion: number,
): Promise<TaskRecord> {
  const scope =
    actor.role === "EMPLOYEE"
      ? Prisma.sql`AND "assigneeId" = ${actor.id}`
      : Prisma.empty;
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "OfficeWorkTask" WHERE "id" = ${id} ${scope} FOR UPDATE`,
  );
  let record = await tx.officeWorkTask.findFirst({
    where: { AND: [{ id }, visibilityWhere(actor)] },
    include: taskInclude,
  });
  if (!record)
    throw new DomainError(
      "NOT_FOUND",
      "The requested task was not found.",
      404,
    );
  if (record.assigneeId) {
    // A concurrent role change cannot grant management rights based on an old join.
    await currentAccount(tx, record.assigneeId, true);
    record = await tx.officeWorkTask.findFirstOrThrow({
      where: { AND: [{ id }, visibilityWhere(actor)] },
      include: taskInclude,
    });
  }
  if (record.archivedAt)
    throw new DomainError(
      "TASK_ARCHIVED",
      "Archived tasks are read-only.",
      409,
    );
  if (record.version !== expectedVersion) throw officeWorkConflict();
  return record;
}
async function saveChange(
  tx: Tx,
  actor: OfficeWorkActor,
  before: TaskRecord,
  data: Prisma.OfficeWorkTaskUncheckedUpdateManyInput,
  action: string,
  reason?: string,
  workUpdate?: string,
) {
  const changed = await tx.officeWorkTask.updateMany({
    where: { id: before.id, version: before.version, archivedAt: null },
    data: { ...data, version: { increment: 1 } },
  });
  if (changed.count !== 1) throw officeWorkConflict();
  const after = await tx.officeWorkTask.findUniqueOrThrow({
    where: { id: before.id },
    include: taskInclude,
  });
  await recordActivity(tx, actor, action, after, before, reason, workUpdate);
  return taskDTO(after, actor, todayInTimezone(officeWorkTimezone()));
}
export async function createOfficeWorkTask(
  actor: OfficeWorkActor,
  raw: unknown,
): Promise<OfficeWorkTaskDTO> {
  const input = officeWorkCreateSchema.parse(raw);
  const fields = {
    title: input.title,
    description: input.description || null,
    priority: input.priority,
    assigneeId: input.assigneeId,
    dueDate: input.dueDate || null,
  };
  const createPayloadHash = createHash("sha256")
    .update(JSON.stringify(fields))
    .digest("hex");
  return write(actor, async (tx, current) => {
    if (!canCreateOfficeWork(current.role))
      throw new DomainError("FORBIDDEN", "You cannot create tasks.", 403);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.requestId}, 0))`;
    const existing = await tx.officeWorkTask.findUnique({
      where: { requestId: input.requestId },
      include: taskInclude,
    });
    if (existing) {
      if (
        existing.createdById !== current.id ||
        existing.createPayloadHash !== createPayloadHash
      )
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "This submission key was already used for another task.",
          409,
        );
      return taskDTO(existing, current, todayInTimezone(officeWorkTimezone()));
    }
    await eligibleAssignee(tx, current, input.assigneeId);
    const record = await tx.officeWorkTask.create({
      data: {
        ...fields,
        dueDate: fields.dueDate
          ? new Date(`${fields.dueDate}T00:00:00.000Z`)
          : null,
        requestId: input.requestId,
        createPayloadHash,
        createdById: current.id,
      },
      include: taskInclude,
    });
    await recordActivity(tx, current, "OFFICE_WORK_CREATED", record);
    return taskDTO(record, current, todayInTimezone(officeWorkTimezone()));
  });
}
export async function updateOfficeWorkTask(
  actor: OfficeWorkActor,
  rawId: string,
  raw: unknown,
): Promise<OfficeWorkTaskDTO> {
  const id = officeWorkIdSchema.parse(rawId),
    input = officeWorkUpdateSchema.parse(raw);
  return write(actor, async (tx, current) => {
    const before = await lockedTask(tx, current, id, input.expectedVersion);
    if (!taskPermissions(current, before).canEdit)
      throw new DomainError("FORBIDDEN", "You cannot edit this task.", 403);
    const description =
        input.description === undefined
          ? before.description
          : input.description || null,
      dueDate =
        input.dueDate === undefined
          ? (before.dueDate?.toISOString().slice(0, 10) ?? null)
          : input.dueDate;
    if (
      before.title === input.title &&
      before.description === description &&
      before.priority === input.priority &&
      (before.dueDate?.toISOString().slice(0, 10) ?? null) === dueDate
    )
      return taskDTO(before, current, todayInTimezone(officeWorkTimezone()));
    return saveChange(
      tx,
      current,
      before,
      {
        title: input.title,
        description,
        priority: input.priority,
        dueDate: dueDate ? new Date(`${dueDate}T00:00:00.000Z`) : null,
      },
      "OFFICE_WORK_EDITED",
    );
  });
}
export async function mutateOfficeWorkTask(
  actor: OfficeWorkActor,
  rawId: string,
  raw: unknown,
): Promise<OfficeWorkTaskDTO> {
  const id = officeWorkIdSchema.parse(rawId),
    input = officeWorkActionSchema.parse(raw);
  return write(actor, async (tx, current) => {
    const before = await lockedTask(tx, current, id, input.expectedVersion);
    if (input.action === "add-update") {
      if (!taskPermissions(current, before).canAddUpdate)
        throw new DomainError(
          "FORBIDDEN",
          "Only the current assignee can add work updates.",
          403,
        );
      return saveChange(
        tx,
        current,
        before,
        {},
        "OFFICE_WORK_UPDATE_ADDED",
        undefined,
        input.update,
      );
    }
    if (input.action === "reassign") {
      if (!taskPermissions(current, before).canReassign)
        throw new DomainError(
          "FORBIDDEN",
          "You cannot reassign this task.",
          403,
        );
      if (before.assigneeId === input.assigneeId)
        return taskDTO(before, current, todayInTimezone(officeWorkTimezone()));
      if (before.status !== "PENDING" && input.confirmReset !== true)
        throw new DomainError(
          "REASSIGN_CONFIRMATION_REQUIRED",
          "Reassigning this task will reset it to Pending and clear its start and completion times. Confirm to continue.",
          409,
        );
      await eligibleAssignee(tx, current, input.assigneeId);
      return saveChange(
        tx,
        current,
        before,
        {
          assigneeId: input.assigneeId,
          status: "PENDING",
          startedAt: null,
          completedAt: null,
        },
        "OFFICE_WORK_REASSIGNED",
      );
    }
    const patch = transitionPatch(current, before, input);
    const actions = {
      start: "OFFICE_WORK_STARTED",
      complete: "OFFICE_WORK_COMPLETED",
      reopen: "OFFICE_WORK_REOPENED",
      archive: "OFFICE_WORK_ARCHIVED",
    };
    return saveChange(
      tx,
      current,
      before,
      patch,
      actions[input.action],
      "reason" in input ? input.reason : undefined,
    );
  });
}
