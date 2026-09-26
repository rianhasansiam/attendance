import "server-only";
import { createHash } from "node:crypto";
import { getEnv } from "@/lib/env";
import { rateLimit } from "@/lib/security";
import { extractClientIp } from "@/modules/network/service";

type Action = "login" | "manage";
const limits: Record<Action, { ip: number; account: number; seconds: number }> =
  {
    login: { ip: 50, account: 10, seconds: 900 },
    manage: { ip: 30, account: 5, seconds: 900 },
  };
export async function limitPasswordAction(
  request: Request,
  action: Action,
  identifier: string,
): Promise<void> {
  const limitsForAction = limits[action];
  // Never trust arbitrary forwarded headers. Without trusted ingress, share a fail-closed bucket.
  const ip = extractClientIp(request.headers, getEnv()) ?? "unavailable";
  const identifierHash = createHash("sha256")
    .update(identifier.trim().toLowerCase())
    .digest("hex");
  await rateLimit(
    `password:${action}:ip:${ip}`,
    limitsForAction.ip,
    limitsForAction.seconds,
  );
  await rateLimit(
    `password:${action}:account:${identifierHash}`,
    limitsForAction.account,
    limitsForAction.seconds,
  );
}
