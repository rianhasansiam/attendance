import { z } from "zod";

export const officeWorkStatuses = ["PENDING", "PROCESSING", "DONE"] as const;
export const officeWorkPriorities = ["LOW", "MEDIUM", "HIGH"] as const;
export type OfficeWorkStatus = (typeof officeWorkStatuses)[number];
export type OfficeWorkPriority = (typeof officeWorkPriorities)[number];
export type OfficeWorkActor = { id: string; role: string; status?: string };
export type OfficeWorkPerson = {
  id: string;
  name: string | null;
  email: string;
  role: string;
};
export type OfficeWorkPermissions = {
  canEdit: boolean;
  canReassign: boolean;
  canStart: boolean;
  canComplete: boolean;
  canReopen: boolean;
  canArchive: boolean;
  canAddUpdate: boolean;
  requiresOverrideReason: boolean;
};
export type OfficeWorkTaskDTO = {
  id: string;
  version: number;
  title: string;
  description: string | null;
  status: OfficeWorkStatus;
  priority: OfficeWorkPriority;
  assigneeId: string | null;
  createdById: string | null;
  assignee: OfficeWorkPerson | null;
  createdBy: OfficeWorkPerson | null;
  dueDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  overdue: boolean;
  permissions: OfficeWorkPermissions;
};
export type OfficeWorkDashboardDTO = {
  total: number;
  pending: number;
  processing: number;
  done: number;
  overdue: number;
  dueToday: number;
  highPriority: number;
  completionPercent: number;
};
export type OfficeWorkWorkloadDTO = {
  assignee: OfficeWorkPerson | null;
  pending: number;
  processing: number;
  done: number;
  overdue: number;
};
export type OfficeWorkOverviewDTO = {
  items: OfficeWorkTaskDTO[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  dashboard: OfficeWorkDashboardDTO;
  workload: OfficeWorkWorkloadDTO[];
  creators: OfficeWorkPerson[];
  assignees: OfficeWorkPerson[];
  today: string;
  timezone: string;
};
export type OfficeWorkActivityDTO = {
  id: string;
  action: string;
  actor: OfficeWorkPerson | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  update: string | null;
  createdAt: string;
};
export type OfficeWorkDetailDTO = {
  task: OfficeWorkTaskDTO;
  activities: OfficeWorkActivityDTO[];
  activityPage: number;
  activityPageSize: number;
  activityTotal: number;
};

export const officeWorkIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const officeWorkDateSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0001-01-01") return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}, "Enter a valid date in YYYY-MM-DD format.");
const fields = {
  title: z.string().trim().min(1, "Enter a title.").max(200),
  description: z.string().trim().max(10000).nullable().optional(),
  priority: z.enum(officeWorkPriorities).default("MEDIUM"),
  dueDate: officeWorkDateSchema.nullable().optional(),
};
export const officeWorkCreateSchema = z
  .object({
    ...fields,
    assigneeId: officeWorkIdSchema,
    requestId: z.uuid(),
  })
  .strict();
const expectedVersion = z.number().int().min(1).max(2147483646);
export const officeWorkUpdateSchema = z
  .object({
    ...fields,
    priority: z.enum(officeWorkPriorities),
    expectedVersion,
  })
  .strict();
const reason = z.string().trim().max(1000).optional();
export const officeWorkActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), expectedVersion, reason }).strict(),
  z.object({ action: z.literal("complete"), expectedVersion, reason }).strict(),
  z
    .object({
      action: z.literal("reopen"),
      expectedVersion,
      reason: z
        .string()
        .trim()
        .min(1, "Enter a reason for reopening.")
        .max(1000),
    })
    .strict(),
  z
    .object({
      action: z.literal("reassign"),
      expectedVersion,
      assigneeId: officeWorkIdSchema,
      confirmReset: z.boolean().optional(),
    })
    .strict(),
  z.object({ action: z.literal("archive"), expectedVersion }).strict(),
  z
    .object({
      action: z.literal("add-update"),
      expectedVersion,
      update: z.string().trim().min(1, "Enter a work update.").max(10000),
    })
    .strict(),
]);
function pageNumber(max: number, fallback: number) {
  return z
    .union([
      z.number(),
      z
        .string()
        .regex(/^\d{1,6}$/)
        .transform(Number),
    ])
    .pipe(z.number().int().min(1).max(max))
    .default(fallback);
}
export const officeWorkListSchema = z
  .object({
    view: z.enum(["all", "mine"]).default("all"),
    search: z.string().trim().max(200).optional(),
    assigneeId: officeWorkIdSchema.optional(),
    createdById: officeWorkIdSchema.optional(),
    priority: z.enum(officeWorkPriorities).optional(),
    from: officeWorkDateSchema.optional(),
    to: officeWorkDateSchema.optional(),
    status: z.enum(officeWorkStatuses).optional(),
    listFilter: z.enum(["overdue", "due-today", "high-priority"]).optional(),
    archived: z.enum(["active", "archived", "all"]).default("active"),
    sort: z
      .enum(["newest", "oldest", "dueDate", "priority", "updated"])
      .default("newest"),
    page: pageNumber(100000, 1),
    pageSize: pageNumber(100, 20),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    path: ["to"],
    message: "The start date must be on or before the end date.",
  });
export const officeWorkActivityQuerySchema = z
  .object({
    page: pageNumber(100000, 1),
    pageSize: pageNumber(100, 20),
  })
  .strict();
export const officeWorkAssigneesQuerySchema = z
  .object({
    search: z.string().trim().max(200).optional(),
  })
  .strict();
export type OfficeWorkListInput = z.input<typeof officeWorkListSchema>;
export type OfficeWorkFilters = z.output<typeof officeWorkListSchema>;
export type OfficeWorkCreateInput = z.input<typeof officeWorkCreateSchema>;
export type OfficeWorkUpdateInput = z.input<typeof officeWorkUpdateSchema>;
export type OfficeWorkActionInput = z.input<typeof officeWorkActionSchema>;
