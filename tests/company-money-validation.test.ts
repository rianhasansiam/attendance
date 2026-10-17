import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  companyMoneyInputSchema,
  companyMoneyListSchema,
  companyMoneyUpdateSchema,
  companyMoneyDeleteSchema,
} from "@/modules/company-money/contracts";

describe("company money validation", () => {
  it("validates full edit fields and bounded optimistic versions without accepting identity fields", () => {
    const update = {
      requestId: randomUUID(),
      type: "ADD",
      amount: "1.00",
      date: "2026-10-17",
      expectedVersion: 1,
    };
    expect(companyMoneyUpdateSchema.parse(update)).toEqual(update);
    for (const changed of [
      { expectedVersion: undefined },
      { expectedVersion: 0 },
      { expectedVersion: 1.5 },
      { expectedVersion: "1" },
      { expectedVersion: 2147483647 },
      { type: "INVALID" },
      { amount: "0.001" },
      { date: "2026-02-29" },
      { note: "x".repeat(501) },
      { createdById: "another-user" },
      { version: 2 },
      { balance: "1000" },
    ])
      expect(
        companyMoneyUpdateSchema.safeParse({ ...update, ...changed }).success,
      ).toBe(false);
  });

  it("requires an independent retry UUID and a bounded version for deletion", () => {
    const deletion = { requestId: randomUUID(), expectedVersion: 1 };
    expect(companyMoneyDeleteSchema.parse(deletion)).toEqual(deletion);
    for (const changed of [
      { requestId: undefined },
      { requestId: "invalid" },
      { expectedVersion: undefined },
      { expectedVersion: 0 },
      { expectedVersion: "1" },
      { expectedVersion: 2147483648 },
      { amount: "1" },
      { deleted: true },
      { actorId: "another-user" },
    ])
      expect(
        companyMoneyDeleteSchema.safeParse({ ...deletion, ...changed }).success,
      ).toBe(false);
  });
  it.each(["0.01", "0.10", "100", "100.5", "9999999999.99"])(
    "accepts positive exact cents: %s",
    (amount) => {
      for (const type of ["ADD", "REMOVE"] as const)
        expect(
          companyMoneyInputSchema.parse({
            requestId: randomUUID(),
            type,
            amount,
            date: "2026-10-17",
          }).amount,
        ).toBe(amount);
    },
  );

  it.each([
    "0",
    "0.00",
    "-1",
    "0.001",
    "1e3",
    "NaN",
    "Infinity",
    "10000000000",
    "",
    10,
    null,
  ])("rejects invalid amounts: %s", (amount) => {
    expect(
      companyMoneyInputSchema.safeParse({
        requestId: randomUUID(),
        type: "ADD",
        amount,
        date: "2026-10-17",
      }).success,
    ).toBe(false);
  });

  it("requires a known transaction type and UUID, and rejects forged ledger fields", () => {
    const input = {
      requestId: randomUUID(),
      type: "ADD",
      amount: "1.00",
      date: "2026-10-17",
    };
    for (const changed of [
      { requestId: undefined },
      { requestId: "invalid" },
      { type: "DEPOSIT" },
      { date: undefined },
      { createdById: "another-admin" },
      { balance: "999999.00" },
      { note: "x".repeat(501) },
    ])
      expect(
        companyMoneyInputSchema.safeParse({ ...input, ...changed }).success,
      ).toBe(false);
    expect(
      companyMoneyInputSchema.parse({
        ...input,
        amount: " 1.00 ",
        note: " Funding ",
      }),
    ).toEqual({ ...input, note: "Funding" });
  });

  it.each([
    "0001-01-01",
    "2000-02-29",
    "2024-02-29",
    "2026-01-01",
    "9999-12-31",
  ])(
    "accepts real calendar dates without limiting past or future selections: %s",
    (date) => {
      expect(
        companyMoneyInputSchema.parse({
          requestId: randomUUID(),
          type: "ADD",
          amount: "1.00",
          date,
        }).date,
      ).toBe(date);
    },
  );

  it.each([
    undefined,
    null,
    "",
    "0000-01-01",
    "1900-02-29",
    "2026-02-29",
    "2026-02-30",
    "2026-04-31",
    "2026-00-01",
    "2026-13-01",
    "2026-01-00",
    "2026-01-32",
    "2026-1-01",
    "2026-01-1",
    "10000-01-01",
    "2026-10-17T00:00:00.000Z",
    " 2026-10-17 ",
    20261017,
  ])(
    "rejects missing, impossible or incorrectly formatted dates: %s",
    (date) => {
      expect(
        companyMoneyInputSchema.safeParse({
          requestId: randomUUID(),
          type: "ADD",
          amount: "1.00",
          date,
        }).success,
      ).toBe(false);
    },
  );

  it("bounds pagination and rejects unknown query parameters", () => {
    expect(companyMoneyListSchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(companyMoneyListSchema.parse({ page: "2", pageSize: "50" })).toEqual(
      {
        page: 2,
        pageSize: 50,
      },
    );
    for (const query of [
      { page: "0" },
      { page: "-1" },
      { page: "1.5" },
      { page: "1e3" },
      { page: "100001" },
      { pageSize: "101" },
      { pageSize: "" },
      { createdById: "someone" },
    ])
      expect(companyMoneyListSchema.safeParse(query).success).toBe(false);
  });
});
