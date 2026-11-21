import type { Prisma } from "@prisma/client";
import type { OfficeWorkActor, OfficeWorkFilters } from "./contracts";
import { visibilityWhere } from "./permissions";

export function officeWorkBaseWhere(
  actor: OfficeWorkActor,
  filters: OfficeWorkFilters,
  activeOnly = false,
): Prisma.OfficeWorkTaskWhereInput {
  const clauses: Prisma.OfficeWorkTaskWhereInput[] = [visibilityWhere(actor)];
  if (filters.view === "mine") clauses.push({ assigneeId: actor.id });
  if (activeOnly || filters.archived === "active")
    clauses.push({ archivedAt: null });
  else if (filters.archived === "archived")
    clauses.push({ archivedAt: { not: null } });
  if (filters.assigneeId) clauses.push({ assigneeId: filters.assigneeId });
  if (filters.createdById) clauses.push({ createdById: filters.createdById });
  if (filters.priority) clauses.push({ priority: filters.priority });
  if (filters.from || filters.to)
    clauses.push({
      dueDate: {
        ...(filters.from
          ? { gte: new Date(`${filters.from}T00:00:00.000Z`) }
          : {}),
        ...(filters.to ? { lte: new Date(`${filters.to}T00:00:00.000Z`) } : {}),
      },
    });
  if (filters.search) {
    const contains = filters.search.replace(/[\\%_]/g, "\\$&");
    clauses.push({
      OR: [
        { title: { contains, mode: "insensitive" } },
        { description: { contains, mode: "insensitive" } },
      ],
    });
  }
  return { AND: clauses };
}
export function officeWorkOverdueWhere(
  today: string,
): Prisma.OfficeWorkTaskWhereInput {
  return {
    archivedAt: null,
    status: { not: "DONE" },
    dueDate: { lt: new Date(`${today}T00:00:00.000Z`) },
  };
}
export function officeWorkListWhere(
  actor: OfficeWorkActor,
  filters: OfficeWorkFilters,
  today: string,
): Prisma.OfficeWorkTaskWhereInput {
  const clauses = [officeWorkBaseWhere(actor, filters)];
  if (filters.status) clauses.push({ status: filters.status });
  if (filters.listFilter === "overdue")
    clauses.push(officeWorkOverdueWhere(today));
  if (filters.listFilter === "due-today")
    clauses.push({
      archivedAt: null,
      status: { not: "DONE" },
      dueDate: new Date(`${today}T00:00:00.000Z`),
    });
  if (filters.listFilter === "high-priority")
    clauses.push({
      archivedAt: null,
      status: { not: "DONE" },
      priority: "HIGH",
    });
  return { AND: clauses };
}
export function officeWorkOrderBy(
  sort: OfficeWorkFilters["sort"],
): Prisma.OfficeWorkTaskOrderByWithRelationInput[] {
  switch (sort) {
    case "oldest":
      return [{ createdAt: "asc" }, { id: "asc" }];
    case "dueDate":
      return [
        { dueDate: { sort: "asc", nulls: "last" } },
        { createdAt: "desc" },
        { id: "desc" },
      ];
    case "priority":
      return [{ priority: "desc" }, { createdAt: "desc" }, { id: "desc" }];
    case "updated":
      return [{ updatedAt: "desc" }, { id: "desc" }];
    default:
      return [{ createdAt: "desc" }, { id: "desc" }];
  }
}
