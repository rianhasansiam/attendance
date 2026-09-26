import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { sendPasswordResetEmail } from "@/lib/email";
import { DomainError } from "@/lib/errors";
import { isAccountEligible } from "@/modules/auth/account-policy";
import { hashPassword } from "@/modules/auth/password";
import {
  forgotPasswordSchema,
  resetPasswordSchema,
} from "@/modules/auth/password-validation";

export const FORGOT_PASSWORD_MESSAGE =
  "If an account exists for this email, password reset instructions have been sent.";
const TOKEN_LIFETIME_MS = 30 * 60 * 1000;
const tokenDigest = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/** Called after the public response, so lookup and SMTP timing cannot enumerate accounts. */
export async function requestPasswordReset(input: unknown): Promise<void> {
  const { email } = forgotPasswordSchema.parse(input);
  const user = await db.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      status: true,
      role: true,
      employee: { select: { id: true } },
    },
  });
  if (!user || !isAccountEligible(user)) return;
  const token = randomBytes(32).toString("hex");
  const tokenHash = tokenDigest(token);
  const created = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
    const current = await tx.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        status: true,
        role: true,
        employee: { select: { id: true } },
      },
    });
    if (!current || !isAccountEligible(current) || current.email !== email)
      return false;
    const now = new Date();
    await tx.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: now },
    });
    await tx.passwordResetToken.create({
      data: {
        userId: user.id,
        email,
        tokenHash,
        expiresAt: new Date(now.getTime() + TOKEN_LIFETIME_MS),
      },
    });
    return true;
  });
  if (!created) return;
  try {
    await sendPasswordResetEmail(email, token);
  } catch {
    // Do not pass SMTP errors to a logger: they can contain recipients, credentials,
    // or the reset message. Failed delivery must leave no usable token behind.
    console.error("Password reset email delivery failed");
    await db.passwordResetToken.updateMany({
      where: { tokenHash, usedAt: null },
      data: { usedAt: new Date() },
    });
  }
}

async function rejectReset(): Promise<never> {
  await db.auditLog.create({
    data: {
      action: "PASSWORD_RESET_FAILED",
      resource: "User",
      newState: { reason: "INVALID_OR_EXPIRED_TOKEN" },
    },
  });
  throw new DomainError(
    "INVALID_RESET_TOKEN",
    "This reset link is invalid or has expired. Request a new link.",
  );
}

export async function resetPassword(input: unknown) {
  const data = resetPasswordSchema.parse(input);
  const tokenHash = tokenDigest(data.token);
  const initial = await db.passwordResetToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      userId: true,
      email: true,
      usedAt: true,
      expiresAt: true,
      user: {
        select: {
          email: true,
          status: true,
          role: true,
          employee: { select: { id: true } },
        },
      },
    },
  });
  if (
    !initial ||
    initial.usedAt ||
    initial.expiresAt <= new Date() ||
    !isAccountEligible(initial.user) ||
    initial.email !== initial.user.email
  )
    return rejectReset();
  const passwordHash = await hashPassword(data.newPassword);
  const changed = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${initial.userId} FOR UPDATE`;
    const token = await tx.passwordResetToken.findUnique({
      where: { tokenHash },
    });
    const user = await tx.user.findUnique({
      where: { id: initial.userId },
      select: {
        id: true,
        email: true,
        emailVerified: true,
        status: true,
        role: true,
        employee: { select: { id: true } },
      },
    });
    const now = new Date();
    if (
      !token ||
      token.userId !== initial.userId ||
      token.usedAt ||
      token.expiresAt <= now ||
      !user ||
      !isAccountEligible(user) ||
      user.email !== token.email
    )
      return false;
    const consumed = await tx.passwordResetToken.updateMany({
      where: { id: token.id, tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (consumed.count !== 1) return false;
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash, emailVerified: user.emailVerified ?? now },
      select: { id: true },
    });
    await tx.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: now },
    });
    await tx.session.deleteMany({ where: { userId: user.id } });
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: "PASSWORD_RESET",
        resource: "User",
        resourceId: user.id,
      },
    });
    return true;
  });
  if (!changed) return rejectReset();
  return {
    message: "Your application password was reset. Please sign in again.",
    signInRequired: true,
  };
}
