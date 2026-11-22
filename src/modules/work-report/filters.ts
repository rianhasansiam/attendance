import type { Prisma } from "@prisma/client";
import type { WorkReportActor, WorkReportFilters } from "./contracts";
import { visibilityWhere } from "./permissions";

export function workReportWhere(
  actor: WorkReportActor,
  filters: WorkReportFilters,
  date: string,
): Prisma.WorkReportWhereInput {
  const clauses: Prisma.WorkReportWhereInput[] = [
    visibilityWhere(actor),
    { workDate: new Date(`${date}T00:00:00.000Z`) },
  ];
  if (filters.mine) clauses.push({ authorId: actor.id });
  if (filters.authorId) clauses.push({ authorId: filters.authorId });
  if (filters.search) {
    const contains = filters.search.replace(/[\\%_]/g, "\\$&");
    clauses.push({
      OR: [
        { title: { contains, mode: "insensitive" } },
        { content: { contains, mode: "insensitive" } },
      ],
    });
  }
  return { AND: clauses };
}
