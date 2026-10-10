import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DomainError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import {
  salaryDateSchema,
  salaryEmployeeIdSchema,
  salaryPeriodSchema,
  validateSalaryRange,
} from "./contracts";

export const SALARY_CALCULATION_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const tokenPayloadSchema = z
  .object({
    actorId: salaryEmployeeIdSchema,
    employeeId: salaryEmployeeIdSchema,
    period: salaryPeriodSchema,
    from: salaryDateSchema,
    to: salaryDateSchema,
    generatedAt: z.iso.datetime(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine(validateSalaryRange);
export type SalaryVersionPayload = z.infer<typeof tokenPayloadSchema>;

/** The complete server projection is covered, including every statement row. */
export function salarySourceDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function signature(payload: string) {
  return createHmac("sha256", getEnv().AUTH_SECRET)
    .update(`salary-statement:v1:${payload}`)
    .digest();
}

export function signSalaryVersion(payload: SalaryVersionPayload): string {
  const serialized = Buffer.from(
    JSON.stringify(tokenPayloadSchema.parse(payload)),
  ).toString("base64url");
  return `${serialized}.${signature(serialized).toString("base64url")}`;
}

export function verifySalaryVersion(
  token: string,
  now = new Date(),
): SalaryVersionPayload {
  let payload: SalaryVersionPayload;
  try {
    const parts = token.split(".");
    if (
      parts.length !== 2 ||
      parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
    )
      throw new Error("Invalid token encoding");
    const [serialized, encodedSignature] = parts;
    const received = Buffer.from(encodedSignature, "base64url");
    const expected = signature(serialized);
    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    )
      throw new Error("Invalid signature");
    payload = tokenPayloadSchema.parse(
      JSON.parse(Buffer.from(serialized, "base64url").toString("utf8")),
    );
  } catch {
    throw new DomainError(
      "SALARY_CALCULATION_INVALID",
      "Calculate this salary again before downloading its statement.",
      409,
    );
  }
  const age = now.valueOf() - new Date(payload.generatedAt).valueOf();
  if (age < 0 || age > SALARY_CALCULATION_MAX_AGE_MS)
    throw new DomainError(
      "SALARY_CALCULATION_EXPIRED",
      "This calculation has expired. Recalculate before downloading the statement.",
      409,
    );
  return payload;
}
