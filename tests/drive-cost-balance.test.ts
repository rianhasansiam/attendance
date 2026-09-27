import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { driveCostBalanceInputSchema } from "@/modules/drive-costs/balance-validation";

describe("drive cost balance input", () => {
  it.each(["0.01", "0.10", "100", "100.5", "9999999999.99"])(
    "accepts positive exact cents: %s",
    (amount) => {
      expect(
        driveCostBalanceInputSchema.parse({ requestId: randomUUID(), amount })
          .amount,
      ).toBe(amount);
    },
  );

  it.each([
    "0",
    "0.00",
    "-10.00",
    "1.001",
    "1e3",
    "NaN",
    "Infinity",
    "10000000000",
    "",
    10,
    null,
  ])("rejects invalid funding amount %s", (amount) => {
    expect(
      driveCostBalanceInputSchema.safeParse({ requestId: randomUUID(), amount })
        .success,
    ).toBe(false);
  });

  it("requires a retry identifier and rejects client-supplied balances or authors", () => {
    for (const input of [
      { amount: "10" },
      { requestId: "invalid", amount: "10" },
      { requestId: randomUUID(), amount: "10", balance: "1000" },
      { requestId: randomUUID(), amount: "10", createdById: "someone-else" },
      { requestId: randomUUID(), amount: "10", note: "x".repeat(501) },
    ])
      expect(driveCostBalanceInputSchema.safeParse(input).success).toBe(false);
  });
});
