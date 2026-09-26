import "server-only";
import { db } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { isAccountEligible } from "@/modules/auth/account-policy";
import { hashPassword, verifyPassword } from "@/modules/auth/password";
import { passwordChangeSchema } from "@/modules/auth/password-validation";

type PasswordActor = { id: string; sessionId: string };

/** The actor is resolved by requireUser; submitted account IDs are never accepted. */
export async function saveOwnPassword(actor: PasswordActor, input: unknown) {
  const data = passwordChangeSchema.parse(input);
  const previous = await db.user.findUnique({
    where: { id: actor.id },
    select: {
      id: true,
      status: true,
      role: true,
      employee: { select: { id: true } },
      passwordHash: true,
    },
  });
  if (!previous || !isAccountEligible(previous))
    throw new DomainError(
      "USER_NOT_AUTHORIZED",
      "Your account is not authorized.",
      403,
    );
  if (
    previous.passwordHash &&
    (!data.currentPassword ||
      !(await verifyPassword(previous.passwordHash, data.currentPassword)))
  )
    throw new DomainError(
      "INVALID_CURRENT_PASSWORD",
      "The current application password is incorrect.",
    );

  // Keep costly password work outside the row lock; the version and session are
  // rechecked inside it so a concurrent reset/change cannot be overwritten.
  const passwordHash = await hashPassword(data.newPassword);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actor.id} FOR UPDATE`;
    const current = await tx.user.findUnique({
      where: { id: actor.id },
      select: {
        id: true,
        status: true,
        role: true,
        employee: { select: { id: true } },
        passwordHash: true,
      },
    });
    const now = new Date();
    const session = await tx.session.findFirst({
      where: { id: actor.sessionId, userId: actor.id, expires: { gt: now } },
      select: { id: true },
    });
    if (!session)
      throw new DomainError(
        "UNAUTHENTICATED",
        "Your session has expired. Please sign in again.",
        401,
      );
    if (!current || !isAccountEligible(current))
      throw new DomainError(
        "USER_NOT_AUTHORIZED",
        "Your account is not authorized.",
        403,
      );
    if (current.passwordHash !== previous.passwordHash)
      throw new DomainError(
        "PASSWORD_CHANGED",
        "Your password changed during this request. Please sign in again.",
        409,
      );
    const action = current.passwordHash ? "PASSWORD_CHANGED" : "PASSWORD_SET";
    await tx.user.update({
      where: { id: actor.id },
      data: { passwordHash },
      select: { id: true },
    });
    await tx.passwordResetToken.updateMany({
      where: { userId: actor.id, usedAt: null },
      data: { usedAt: now },
    });
    await tx.session.deleteMany({ where: { userId: actor.id } });
    await tx.auditLog.create({
      data: {
        actorId: actor.id,
        action,
        resource: "User",
        resourceId: actor.id,
      },
    });
    return {
      message: "Your application password was saved. Please sign in again.",
      signInRequired: true,
    };
  });
}
