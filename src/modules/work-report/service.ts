import "server-only";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit/service";
import {
  workReportAuthorsQuerySchema,
  workReportCreateSchema,
  workReportDeleteSchema,
  workReportIdSchema,
  workReportListSchema,
  workReportUpdateSchema,
  type WorkReportActor,
  type WorkReportAuthor,
  type WorkReportDeletionDTO,
  type WorkReportDTO,
  type WorkReportFeedDTO,
} from "./contracts";
import {
  authorizeReportOwnership,
  authorizeWorkReport,
  reportPermissions,
  visibilityWhere,
} from "./permissions";
import {
  todayInTimezone,
  workReportConflict,
  workReportTimezone,
} from "./policy";
import { workReportWhere } from "./filters";

/** Attribution is deliberately separate from the application's email-bearing user projections. */
const authorSelect = { id: true, name: true, image: true, role: true } as const;
const reportInclude = {
  author: { select: authorSelect },
} satisfies Prisma.WorkReportInclude;
type ReportRecord = Prisma.WorkReportGetPayload<{
  include: typeof reportInclude;
}>;
type Tx = Prisma.TransactionClient;
type CurrentActor = { id: string; role: string; status: string };

async function currentActor(
  tx: Tx,
  actor: WorkReportActor,
  lock: boolean,
): Promise<CurrentActor> {
  let current: CurrentActor | null;
  if (lock) {
    const [record] = await tx.$queryRaw<CurrentActor[]>`
      SELECT "id", "role", "status" FROM "User" WHERE "id" = ${actor.id || ""} FOR SHARE
    `;
    current = record ?? null;
  } else
    current = actor.id
      ? await tx.user.findUnique({
          where: { id: actor.id },
          select: { id: true, role: true, status: true },
        })
      : null;
  if (!current)
    throw new DomainError(
      "FORBIDDEN",
      "You do not have access to Work Report.",
      403,
    );
  authorizeWorkReport(current);
  return current;
}
function read<T>(
  actor: WorkReportActor,
  operation: (tx: Tx, current: CurrentActor) => Promise<T>,
): Promise<T> {
  return db.$transaction(
    async (tx) => operation(tx, await currentActor(tx, actor, false)),
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 10000,
      timeout: 15000,
    },
  );
}
function isDatabaseConflict(error: unknown): boolean {
  const queue: unknown[] = [error];
  for (let index = 0; index < queue.length && index < 20; index++) {
    const item = queue[index];
    if (!item || typeof item !== "object") continue;
    const fields = item as Record<string, unknown>;
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
  actor: WorkReportActor,
  operation: (tx: Tx, current: CurrentActor) => Promise<T>,
): Promise<T> {
  try {
    return await db.$transaction(
      async (tx) => {
        const current = await currentActor(tx, actor, true);
        await tx.$queryRaw`SELECT set_config('app.work_report_actor_id', ${current.id}, true)`;
        return operation(tx, current);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10000,
        timeout: 15000,
      },
    );
  } catch (error) {
    if (isDatabaseConflict(error)) throw workReportConflict();
    throw error;
  }
}
function reportDTO(
  report: ReportRecord,
  actor: WorkReportActor,
): WorkReportDTO {
  return {
    id: report.id,
    version: report.version,
    authorId: report.authorId,
    author: report.author,
    title: report.title,
    content: report.content,
    workDate: report.workDate.toISOString().slice(0, 10),
    createdAt: report.createdAt.toISOString(),
    updatedAt: report.updatedAt.toISOString(),
    edited: report.version > 1,
    permissions: reportPermissions(actor, report),
  };
}
function snapshot(report: ReportRecord): Prisma.InputJsonObject {
  return {
    authorId: report.authorId,
    title: report.title,
    content: report.content,
    workDate: report.workDate.toISOString().slice(0, 10),
    version: report.version,
    createdAt: report.createdAt.toISOString(),
    updatedAt: report.updatedAt.toISOString(),
    deletedAt: report.deletedAt?.toISOString() ?? null,
  };
}
function notFound(): DomainError {
  return new DomainError(
    "NOT_FOUND",
    "The requested report was not found.",
    404,
  );
}
export async function listWorkReports(
  actor: WorkReportActor,
  raw: unknown = {},
): Promise<WorkReportFeedDTO> {
  const filters = workReportListSchema.parse(raw);
  return read(actor, async (tx, current) => {
    const timezone = workReportTimezone(),
      today = todayInTimezone(timezone),
      date = filters.date ?? today;
    const where = workReportWhere(current, filters, date);
    const total = await tx.workReport.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
    const page = Math.min(filters.page, totalPages);
    const records = await tx.workReport.findMany({
      where,
      include: reportInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * filters.pageSize,
      take: filters.pageSize,
    });
    return {
      items: records.map((report) => reportDTO(report, current)),
      total,
      page,
      pageSize: filters.pageSize,
      totalPages,
      date,
      today,
      timezone,
    };
  });
}
export async function getWorkReport(
  actor: WorkReportActor,
  rawId: string,
): Promise<WorkReportDTO> {
  const id = workReportIdSchema.parse(rawId);
  return read(actor, async (tx, current) => {
    const report = await tx.workReport.findFirst({
      where: { id, ...visibilityWhere(current) },
      include: reportInclude,
    });
    if (!report) throw notFound();
    return reportDTO(report, current);
  });
}
export async function listWorkReportAuthors(
  actor: WorkReportActor,
  raw: unknown = {},
): Promise<WorkReportAuthor[]> {
  const filters = workReportAuthorsQuerySchema.parse(raw);
  return read(actor, async (tx, current) => {
    const contains = filters.search?.replace(/[\\%_]/g, "\\$&");
    return tx.user.findMany({
      where: {
        workReports: {
          some: {
            ...visibilityWhere(current),
            ...(filters.date
              ? { workDate: new Date(`${filters.date}T00:00:00.000Z`) }
              : {}),
          },
        },
        ...(contains ? { name: { contains, mode: "insensitive" } } : {}),
      },
      select: authorSelect,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: 100,
    });
  });
}
export async function createWorkReport(
  actor: WorkReportActor,
  raw: unknown,
): Promise<WorkReportDTO> {
  const input = workReportCreateSchema.parse(raw);
  const fields = { title: input.title || null, content: input.content };
  // Include only caller-writable facts: a retry tomorrow still identifies today's original post.
  const createPayloadHash = createHash("sha256")
    .update(JSON.stringify(fields))
    .digest("hex");
  return write(actor, async (tx, current) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`work-report:${input.requestId}`}, 0))`;
    const existing = await tx.workReport.findUnique({
      where: { requestId: input.requestId },
      include: reportInclude,
    });
    if (existing) {
      if (
        existing.authorId !== current.id ||
        existing.createPayloadHash !== createPayloadHash
      )
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "This submission key was already used for another report.",
          409,
        );
      if (existing.deletedAt) throw notFound();
      return reportDTO(existing, current);
    }
    const today = todayInTimezone(workReportTimezone());
    const report = await tx.workReport.create({
      data: {
        ...fields,
        authorId: current.id,
        workDate: new Date(`${today}T00:00:00.000Z`),
        requestId: input.requestId,
        createPayloadHash,
      },
      include: reportInclude,
    });
    await writeAudit(
      current.id,
      "WORK_REPORT_CREATED",
      "WorkReport",
      report.id,
      undefined,
      snapshot(report),
      tx,
    );
    return reportDTO(report, current);
  });
}
async function lockedOwnReport(
  tx: Tx,
  actor: WorkReportActor,
  id: string,
  expectedVersion: number,
): Promise<ReportRecord> {
  await tx.$queryRaw`SELECT "id" FROM "WorkReport" WHERE "id" = ${id} AND "authorId" = ${actor.id} AND "deletedAt" IS NULL FOR UPDATE`;
  const report = await tx.workReport.findFirst({
    where: { id, ...visibilityWhere(actor) },
    include: reportInclude,
  });
  if (!report) throw notFound();
  authorizeReportOwnership(actor, report);
  if (report.version !== expectedVersion) throw workReportConflict();
  return report;
}
async function saveChange(
  tx: Tx,
  actor: WorkReportActor,
  before: ReportRecord,
  data: Prisma.WorkReportUpdateManyMutationInput,
  action: string,
): Promise<ReportRecord> {
  const changed = await tx.workReport.updateMany({
    where: {
      id: before.id,
      authorId: actor.id,
      version: before.version,
      ...visibilityWhere(actor),
    },
    data: { ...data, version: { increment: 1 } },
  });
  if (changed.count !== 1) throw workReportConflict();
  const after = await tx.workReport.findUniqueOrThrow({
    where: { id: before.id },
    include: reportInclude,
  });
  await writeAudit(
    actor.id,
    action,
    "WorkReport",
    before.id,
    snapshot(before),
    snapshot(after),
    tx,
  );
  return after;
}
export async function updateWorkReport(
  actor: WorkReportActor,
  rawId: string,
  raw: unknown,
): Promise<WorkReportDTO> {
  const id = workReportIdSchema.parse(rawId),
    input = workReportUpdateSchema.parse(raw);
  return write(actor, async (tx, current) => {
    const before = await lockedOwnReport(
      tx,
      current,
      id,
      input.expectedVersion,
    );
    const title =
      input.title === undefined ? before.title : input.title || null;
    if (before.title === title && before.content === input.content)
      return reportDTO(before, current);
    const after = await saveChange(
      tx,
      current,
      before,
      { title, content: input.content },
      "WORK_REPORT_UPDATED",
    );
    return reportDTO(after, current);
  });
}
export async function deleteWorkReport(
  actor: WorkReportActor,
  rawId: string,
  raw: unknown,
): Promise<WorkReportDeletionDTO> {
  const id = workReportIdSchema.parse(rawId),
    input = workReportDeleteSchema.parse(raw);
  return write(actor, async (tx, current) => {
    const before = await lockedOwnReport(
      tx,
      current,
      id,
      input.expectedVersion,
    );
    const after = await saveChange(
      tx,
      current,
      before,
      { deletedAt: new Date() },
      "WORK_REPORT_DELETED",
    );
    return { id: after.id, version: after.version, deleted: true };
  });
}
