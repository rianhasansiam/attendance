import { z } from "zod";

export const driveCostBalanceInputSchema = z
  .object({
    requestId: z.uuid(),
    amount: z
      .string()
      .trim()
      .regex(
        /^\d{1,10}(?:\.\d{1,2})?$/,
        "Enter an amount with at most two decimal places.",
      )
      .refine(
        (value) => /[1-9]/.test(value),
        "Enter an amount greater than zero.",
      ),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
