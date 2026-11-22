import { z } from "zod";

export type WorkReportActor = { id: string; role: string; status?: string };
export type WorkReportAuthor = {
  id: string;
  name: string | null;
  image: string | null;
  role: string;
};
export type WorkReportPermissions = { canEdit: boolean; canDelete: boolean };
export type WorkReportDTO = {
  id: string;
  version: number;
  authorId: string | null;
  author: WorkReportAuthor | null;
  title: string | null;
  content: string;
  workDate: string;
  createdAt: string;
  updatedAt: string;
  edited: boolean;
  permissions: WorkReportPermissions;
};
export type WorkReportFeedDTO = {
  items: WorkReportDTO[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  date: string;
  today: string;
  timezone: string;
};
export type WorkReportDeletionDTO = {
  id: string;
  version: number;
  deleted: true;
};

export const workReportIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const workReportDateSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0001-01-01") return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}, "Enter a valid date in YYYY-MM-DD format.");
const title = z.string().trim().max(200).nullable().optional();
const content = z
  .string()
  .trim()
  .min(1, "Describe your work before posting.")
  .max(10000);
const expectedVersion = z.number().int().min(1).max(2147483646);
export const workReportCreateSchema = z
  .object({
    title,
    content,
    requestId: z.uuid().transform((value) => value.toLowerCase()),
  })
  .strict();
export const workReportUpdateSchema = z
  .object({ title, content, expectedVersion })
  .strict();
export const workReportDeleteSchema = z.object({ expectedVersion }).strict();
function pageNumber(maximum: number, fallback: number) {
  return z
    .union([
      z.number(),
      z
        .string()
        .regex(/^\d{1,6}$/)
        .transform(Number),
    ])
    .pipe(z.number().int().min(1).max(maximum))
    .default(fallback);
}
export const workReportListSchema = z
  .object({
    date: workReportDateSchema.optional(),
    authorId: workReportIdSchema.optional(),
    mine: z
      .union([
        z.boolean(),
        z.enum(["true", "false"]).transform((value) => value === "true"),
      ])
      .default(false),
    search: z.string().trim().max(200).optional(),
    page: pageNumber(100000, 1),
    pageSize: pageNumber(100, 20),
  })
  .strict();
export const workReportAuthorsQuerySchema = z
  .object({
    search: z.string().trim().max(200).optional(),
    date: workReportDateSchema.optional(),
  })
  .strict();
export type WorkReportListInput = z.input<typeof workReportListSchema>;
export type WorkReportFilters = z.output<typeof workReportListSchema>;
export type WorkReportCreateInput = z.input<typeof workReportCreateSchema>;
export type WorkReportUpdateInput = z.input<typeof workReportUpdateSchema>;
export type WorkReportDeleteInput = z.input<typeof workReportDeleteSchema>;
