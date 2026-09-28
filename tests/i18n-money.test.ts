import { describe, expect, it } from "vitest";
import { formatMoney } from "@/i18n/format-money";

describe.each(["en", "zh-CN"])("exact currency display in %s", (locale) => {
  it("preserves every cent beyond the safe integer range and keeps the currency", () => {
    expect(formatMoney("-99999999999999999990.99", "BDT", locale)).toBe(
      "-BDT 99,999,999,999,999,999,990.99",
    );
    expect(formatMoney("12.3", "BDT", locale)).toBe("BDT 12.30");
    expect(formatMoney("0", "BDT", locale)).toBe("BDT 0.00");
  });
  it("rejects invalid decimal input instead of rounding stored values", () => {
    expect(() => formatMoney("12.345", "BDT", locale)).toThrow(
      "Invalid decimal money value.",
    );
  });
});
