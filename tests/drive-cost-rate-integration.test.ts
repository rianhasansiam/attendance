import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { PdfReport } from "@/modules/reports/pdf";

const mocks = vi.hoisted(() => ({
  requireDriveCostManager: vi.fn(),
  createPdf: vi.fn<(report: PdfReport) => Promise<Uint8Array>>(),
}));
vi.mock("@/lib/auth", () => ({
  requireDriveCostManager: mocks.requireDriveCostManager,
}));
vi.mock("@/modules/reports/pdf", () => ({ createReportPdf: mocks.createPdf }));

import { GET as calculate } from "@/app/api/admin/drive-costs/calculate/route";
import { db } from "@/lib/db";
import { getDriveCostBalance } from "@/modules/drive-costs/balance";
import { updateDriveCostPaymentStatus } from "@/modules/drive-costs/payment-status";
import { getDriveCostReport } from "@/modules/drive-costs/report";
import { saveDriveCost } from "@/modules/management/catalog";

const database = process.env.TEST_DATABASE_URL;
const actor = { id: "", role: "SUPER_ADMIN" as const };
const tag = `Rate change ${randomUUID()}`;
const tripInput = {
  date: "2026-09-25",
  destinationFrom: tag,
  destinationTo: "Warehouse",
  kilometers: 10.01,
};

async function calculation(paymentStatus?: "PAID" | "UNPAID") {
  const params = new URLSearchParams({ from: "2026-09-25", to: "2026-09-26" });
  if (paymentStatus) params.set("paymentStatus", paymentStatus);
  const response = await calculate(
    new Request(
      `https://attendance.example.test/api/admin/drive-costs/calculate?${params}`,
    ),
  );
  expect(response.status).toBe(200);
  return (await response.json()).data as {
    totalRecords: number;
    totalCost: string;
    records: { id: string; ratePerKilometer: string; totalCost: string }[];
  };
}

describe.skipIf(!database)("date-based drive cost persistence", () => {
  beforeAll(async () => {
    if (!database || !new URL(database).pathname.includes("test"))
      throw new Error("Rate tests require a disposable test database");
    process.env.DATABASE_URL = database;
    actor.id = (
      await db.user.create({
        data: {
          email: `drive-rate-${randomUUID()}@example.test`,
          role: "SUPER_ADMIN",
        },
      })
    ).id;
    mocks.requireDriveCostManager.mockResolvedValue(actor);
    mocks.createPdf.mockResolvedValue(new TextEncoder().encode("%PDF-1.7\n"));
  });

  afterEach(async () => {
    if (actor.id)
      await db.driveCost.deleteMany({ where: { createdById: actor.id } });
    mocks.createPdf.mockClear();
  });

  afterAll(async () => {
    // Keep the actor referenced by append-only audit history in this disposable DB.
    await db.$disconnect();
  });

  it.each([
    {
      rateType: "IN_TIME" as const,
      isRoundTrip: false,
      oldRate: "5.00",
      oldCost: "50.05",
      newRate: "5.50",
      newCost: "55.06",
    },
    {
      rateType: "OVER_TIME" as const,
      isRoundTrip: true,
      oldRate: "10.00",
      oldCost: "200.20",
      newRate: "11.00",
      newCost: "220.22",
    },
  ])(
    "recalculates $rateType trips across September 26 without compounding and deducts only paid costs",
    async ({ rateType, isRoundTrip, oldRate, oldCost, newRate, newCost }) => {
      const initial = await getDriveCostBalance(actor);
      const input = { ...tripInput, rateType, isRoundTrip };
      const created = await saveDriveCost(actor, input);
      expect(created.ratePerKilometer.toFixed(2)).toBe(oldRate);
      expect(created.totalCost.toFixed(2)).toBe(oldCost);

      const newInput = { ...input, date: "2026-09-26" };
      const updated = await saveDriveCost(actor, newInput, created.id);
      expect(updated.ratePerKilometer.toFixed(2)).toBe(newRate);
      expect(updated.totalCost.toFixed(2)).toBe(newCost);
      expect(await getDriveCostBalance(actor)).toEqual(initial);

      const paid = await updateDriveCostPaymentStatus(actor, created.id, {
        paymentStatus: "PAID",
      });
      expect(paid.ratePerKilometer.toFixed(2)).toBe(newRate);
      expect(paid.totalCost.toFixed(2)).toBe(newCost);
      expect((await getDriveCostBalance(actor)).balance).toBe(
        new Prisma.Decimal(initial.balance).minus(newCost).toFixed(2),
      );

      const repeated = await saveDriveCost(actor, newInput, created.id);
      expect(repeated.paymentStatus).toBe("PAID");
      expect(repeated.totalCost.toFixed(2)).toBe(newCost);
      expect((await getDriveCostBalance(actor)).balance).toBe(
        new Prisma.Decimal(initial.balance).minus(newCost).toFixed(2),
      );

      const historical = await saveDriveCost(actor, input, created.id);
      expect(historical.ratePerKilometer.toFixed(2)).toBe(oldRate);
      expect(historical.totalCost.toFixed(2)).toBe(oldCost);
      expect((await getDriveCostBalance(actor)).balance).toBe(
        new Prisma.Decimal(initial.balance).minus(oldCost).toFixed(2),
      );

      const unpaid = await saveDriveCost(
        actor,
        { paymentStatus: "UNPAID" },
        created.id,
      );
      expect(unpaid.ratePerKilometer.toFixed(2)).toBe(oldRate);
      expect(unpaid.totalCost.toFixed(2)).toBe(oldCost);
      expect(await getDriveCostBalance(actor)).toEqual(initial);
    },
  );

  it("uses saved rounded costs in calculations, payment filters, report totals and the balance", async () => {
    const initial = await calculation();
    const initialPaid = await calculation("PAID");
    const initialUnpaid = await calculation("UNPAID");
    const initialBalance = await getDriveCostBalance(actor);

    const historicalInput = {
      ...tripInput,
      kilometers: 12.34,
      rateType: "IN_TIME",
    };
    const historical = await saveDriveCost(actor, historicalInput);
    const cents = await saveDriveCost(actor, {
      ...tripInput,
      date: "2026-09-26",
      kilometers: 0.01,
      rateType: "IN_TIME",
      paymentStatus: "PAID",
    });
    const roundTrip = await saveDriveCost(actor, {
      ...tripInput,
      date: "2026-09-26",
      kilometers: 3.21,
      isRoundTrip: true,
      rateType: "OVER_TIME",
      paymentStatus: "PAID",
    });
    expect(cents.totalCost.toFixed(2)).toBe("0.06");
    expect(roundTrip.totalCost.toFixed(2)).toBe("70.62");

    const beforeEdit = await calculation();
    expect(beforeEdit.totalCost).toBe(
      new Prisma.Decimal(initial.totalCost).plus("132.38").toFixed(2),
    );
    await saveDriveCost(
      actor,
      { ...historicalInput, date: "2026-09-26" },
      historical.id,
    );

    const all = await calculation();
    expect(all.totalRecords).toBe(initial.totalRecords + 3);
    expect(all.totalCost).toBe(
      new Prisma.Decimal(initial.totalCost).plus("138.55").toFixed(2),
    );
    expect(all.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: historical.id,
          ratePerKilometer: "5.5",
          totalCost: "67.87",
        }),
        expect.objectContaining({
          id: cents.id,
          ratePerKilometer: "5.5",
          totalCost: "0.06",
        }),
        expect.objectContaining({
          id: roundTrip.id,
          ratePerKilometer: "11",
          totalCost: "70.62",
        }),
      ]),
    );
    const paid = await calculation("PAID");
    expect(paid.totalRecords).toBe(initialPaid.totalRecords + 2);
    expect(paid.totalCost).toBe(
      new Prisma.Decimal(initialPaid.totalCost).plus("70.68").toFixed(2),
    );
    const unpaid = await calculation("UNPAID");
    expect(unpaid.totalRecords).toBe(initialUnpaid.totalRecords + 1);
    expect(unpaid.totalCost).toBe(
      new Prisma.Decimal(initialUnpaid.totalCost).plus("67.87").toFixed(2),
    );
    expect((await getDriveCostBalance(actor)).balance).toBe(
      new Prisma.Decimal(initialBalance.balance).minus("70.68").toFixed(2),
    );

    await getDriveCostReport(actor, {
      from: "2026-09-25",
      to: "2026-09-26",
      q: tag,
    });
    expect(mocks.createPdf.mock.lastCall?.[0].summary).toEqual([
      { label: "Total trips", value: "3" },
      { label: "Total kilometers", value: "18.77" },
      { label: "Total cost (BDT)", value: "138.55" },
      { label: "In-time cost (BDT)", value: "67.93" },
      { label: "Overtime cost (BDT)", value: "70.62" },
    ]);
    expect(mocks.createPdf.mock.lastCall?.[0].rows).toEqual(
      expect.arrayContaining([
        [
          "2026-09-26",
          tag,
          "Warehouse",
          "One way",
          "In-time",
          "12.34",
          "5.50",
          "67.87",
        ],
        [
          "2026-09-26",
          tag,
          "Warehouse",
          "One way",
          "In-time",
          "0.01",
          "5.50",
          "0.06",
        ],
        [
          "2026-09-26",
          tag,
          "Warehouse",
          "Round trip (×2)",
          "Overtime",
          "6.42",
          "11.00",
          "70.62",
        ],
      ]),
    );
    await getDriveCostReport(actor, {
      from: "2026-09-25",
      to: "2026-09-26",
      q: tag,
      paymentStatus: "PAID",
    });
    expect(mocks.createPdf.mock.lastCall?.[0].summary).toEqual([
      { label: "Total trips", value: "2" },
      { label: "Total kilometers", value: "6.43" },
      { label: "Total cost (BDT)", value: "70.68" },
      { label: "In-time cost (BDT)", value: "0.06" },
      { label: "Overtime cost (BDT)", value: "70.62" },
    ]);
  });
});
