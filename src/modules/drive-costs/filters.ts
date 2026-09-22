import type { Prisma } from "@prisma/client";
import { utcDate } from "@/modules/management/validation";

export type DriveCostFilters = {
  from?: string;
  to?: string;
  q?: string;
};

/** Share the inclusive date and destination filters between the list and PDF. */
export function driveCostWhere({ from, to, q }: DriveCostFilters) {
  return {
    ...(q
      ? {
          OR: [
            { destinationFrom: { contains: q, mode: "insensitive" as const } },
            { destinationTo: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
    ...(from || to
      ? {
          date: {
            ...(from ? { gte: utcDate(from) } : {}),
            ...(to ? { lte: utcDate(to) } : {}),
          },
        }
      : {}),
  } satisfies Prisma.DriveCostWhereInput;
}
