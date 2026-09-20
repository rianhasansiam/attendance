import "server-only";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { DomainError } from "@/lib/errors";

export function assertSameOrigin(request: Request): void {
  if (request.headers.get("origin") !== new URL(getEnv().AUTH_URL).origin)
    throw new DomainError(
      "INVALID_ORIGIN",
      "The request origin could not be verified.",
      403,
    );
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new DomainError(
      "INVALID_ORIGIN",
      "Cross-site requests are not permitted.",
      403,
    );
}
export async function rateLimit(
  key: string,
  limit = 30,
  windowSeconds = 60,
): Promise<void> {
  const now = Date.now();
  const window = Math.floor(now / (windowSeconds * 1000));
  const hash = createHash("sha256").update(`${key}:${window}`).digest("hex");
  const bucket = await db.rateLimit.upsert({
    where: { key: hash },
    create: {
      key: hash,
      count: 1,
      resetAt: new Date((window + 1) * windowSeconds * 1000),
    },
    update: { count: { increment: 1 } },
  });
  if (bucket.count > limit)
    throw new DomainError(
      "RATE_LIMITED",
      "Too many attempts. Please wait and try again.",
      429,
    );
}
