import { z } from "zod";
import { api } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";

const querySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export function GET(request: Request) {
  return api(async () => {
    await requireAdmin();
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const { from, to } = querySchema.parse(params);

    const dateFrom = new Date(`${from}T00:00:00Z`);
    const dateTo = to ? new Date(`${to}T00:00:00Z`) : dateFrom;

    const where = {
      date: { gte: dateFrom, lte: dateTo },
    };

    const records = await db.driveCost.findMany({
      where,
      orderBy: [{ date: "asc" }, { id: "asc" }],
    });

    const aggregation = await db.driveCost.aggregate({
      where,
      _sum: { totalCost: true, kilometers: true },
      _count: true,
    });

    // Group totals by rate type
    const byRateType = await db.driveCost.groupBy({
      by: ["rateType"],
      where,
      _sum: { totalCost: true, kilometers: true },
      _count: true,
    });

    const inTimeGroup = byRateType.find((g) => g.rateType === "IN_TIME");
    const overTimeGroup = byRateType.find((g) => g.rateType === "OVER_TIME");

    return {
      dateFrom: from,
      dateTo: to || from,
      isSingleDay: !to || to === from,
      totalRecords: aggregation._count,
      totalKilometers: new Prisma.Decimal(
        aggregation._sum.kilometers?.toString() || "0",
      ).toFixed(2),
      totalCost: new Prisma.Decimal(
        aggregation._sum.totalCost?.toString() || "0",
      ).toFixed(2),
      breakdown: {
        inTime: {
          records: inTimeGroup?._count || 0,
          kilometers: new Prisma.Decimal(
            inTimeGroup?._sum.kilometers?.toString() || "0",
          ).toFixed(2),
          totalCost: new Prisma.Decimal(
            inTimeGroup?._sum.totalCost?.toString() || "0",
          ).toFixed(2),
        },
        overTime: {
          records: overTimeGroup?._count || 0,
          kilometers: new Prisma.Decimal(
            overTimeGroup?._sum.kilometers?.toString() || "0",
          ).toFixed(2),
          totalCost: new Prisma.Decimal(
            overTimeGroup?._sum.totalCost?.toString() || "0",
          ).toFixed(2),
        },
      },
      records,
    };
  });
}
