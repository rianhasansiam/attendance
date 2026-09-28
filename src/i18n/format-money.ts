/** Locale-aware ledger display without converting decimal amounts to floating point. */
export function formatMoney(
  amount: string,
  currency: string,
  locale = "en",
): string {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
  if (!match) throw new Error("Invalid decimal money value.");
  const [, sign, whole, fraction = ""] = match;
  const integer = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(BigInt(whole));
  const decimal =
    new Intl.NumberFormat(locale)
      .formatToParts(1.1)
      .find((part) => part.type === "decimal")?.value ?? ".";
  return `${sign}${currency} ${integer}${decimal}${fraction.padEnd(2, "0")}`;
}
