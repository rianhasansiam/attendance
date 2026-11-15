import type { Prisma } from "@prisma/client";

function searchAmount(search: string): string | null {
  // Grouped input must have complete thousands groups. Currency signs,
  // exponents and extra decimal places remain ordinary note searches.
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(search)) return null;
  const [whole, fraction = ""] = search.replaceAll(",", "").split(".");
  const integer = whole.replace(/^0+(?=\d)/, "");
  const amount = `${integer}.${fraction.padEnd(2, "0")}`;
  if (integer.length > 10 || !/[1-9]/.test(amount)) return null;
  return amount;
}

/** Search history by literal note text or an exact decimal amount. */
export function companyMoneyHistoryWhere(
  search?: string,
): Prisma.CompanyMoneyTransactionWhereInput {
  const query = search?.trim();
  if (!query) return {};
  const note = {
    note: {
      contains: query.replace(/[\\%_]/g, "\\$&"),
      mode: "insensitive" as const,
    },
  };
  const amount = searchAmount(query);
  return amount ? { OR: [note, { amount }] } : note;
}
