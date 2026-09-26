import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

type AuditClient = Pick<Prisma.TransactionClient, "auditLog">;
const sensitive =
  /^(access_token|refresh_token|id_token|sessionToken|publicKey|counter|credentialId|challenge|secret|password|passwordHash|tokenHash|resetToken|token|newPassword|currentPassword|confirmPassword|cookie)$/i;

/** Persist only administrative snapshots; cryptographic material is redacted defensively. */
export function auditSnapshot(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (key, item: unknown) => {
      if (sensitive.test(key)) return "[redacted]";
      if (typeof item === "bigint") return item.toString();
      return item;
    }),
  ) as Prisma.InputJsonValue;
}

export async function writeAudit(
  actorId: string,
  action: string,
  resource: string,
  resourceId: string,
  previousState?: unknown,
  newState?: unknown,
  client: AuditClient = db,
) {
  return client.auditLog.create({
    data: {
      actorId,
      action,
      resource,
      resourceId,
      ...(previousState === undefined
        ? {}
        : { previousState: auditSnapshot(previousState) }),
      ...(newState === undefined ? {} : { newState: auditSnapshot(newState) }),
    },
  });
}
