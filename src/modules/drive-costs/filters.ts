import type { DriveCostPaymentStatus, Prisma } from "@prisma/client";
import { utcDate } from "@/modules/management/validation";

export type DriveCostFilters = {
  from?: string;
  to?: string;
  q?: string;
  paymentStatus?: DriveCostPaymentStatus;
};

/** Keep list, calculation, and PDF filters consistent. */
export function driveCostWhere({
  from,
  to,
  q,
  paymentStatus,
}: DriveCostFilters) {
  return {
    ...(paymentStatus ? { paymentStatus } : {}),
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
