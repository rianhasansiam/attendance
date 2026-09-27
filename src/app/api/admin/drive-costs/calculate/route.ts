import { z } from "zod";
import { api } from "@/lib/api";
import { requireDriveCostManager } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { driveCostWhere } from "@/modules/drive-costs/filters";
import { driveCostPaymentFilterSchema } from "@/modules/management/validation";

const querySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  paymentStatus: driveCostPaymentFilterSchema,
});

export function GET(request: Request) {
  return api(async () => {
    await requireDriveCostManager();
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const { from, to, paymentStatus } = querySchema.parse(params);
    const where = driveCostWhere({ from, to: to || from, paymentStatus });

    const records = await db.driveCost.findMany({
      where,
      orderBy: [{ date: "asc" }, { id: "asc" }],
    });

    // Sum the displayed records so detail and totals share one snapshot.
    const totals = {
      IN_TIME: {
        records: 0,
        kilometers: new Prisma.Decimal(0),
        totalCost: new Prisma.Decimal(0),
      },
      OVER_TIME: {
        records: 0,
        kilometers: new Prisma.Decimal(0),
        totalCost: new Prisma.Decimal(0),
      },
    };
    for (const record of records) {
      const group = totals[record.rateType];
      group.records += 1;
      group.kilometers = group.kilometers.add(
        record.kilometers.mul(record.isRoundTrip ? 2 : 1),
      );
      group.totalCost = group.totalCost.add(record.totalCost);
    }
    const formatGroup = (group: (typeof totals)["IN_TIME"]) => ({
      records: group.records,
      kilometers: group.kilometers.toFixed(2),
      totalCost: group.totalCost.toFixed(2),
    });

    return {
      dateFrom: from,
      dateTo: to || from,
      isSingleDay: !to || to === from,
      paymentStatus: paymentStatus ?? null,
      totalRecords: records.length,
      totalKilometers: totals.IN_TIME.kilometers
        .add(totals.OVER_TIME.kilometers)
        .toFixed(2),
      totalCost: totals.IN_TIME.totalCost
        .add(totals.OVER_TIME.totalCost)
        .toFixed(2),
      breakdown: {
        inTime: formatGroup(totals.IN_TIME),
        overTime: formatGroup(totals.OVER_TIME),
      },
      records,
    };
  });
}
