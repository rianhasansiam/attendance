import "server-only";
import { db } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { credentialsSchema } from "./password-validation";
import { verifyPassword } from "./password";
import { isAccountEligible } from "./account-policy";
import { limitPasswordAction } from "./auth-rate-limit";

export async function authorizeCredentials(
  credentials: Partial<Record<string, unknown>>,
  request: Request,
) {
  const parsed = credentialsSchema.safeParse(credentials);
  try {
    await limitPasswordAction(
      request,
      "login",
      parsed.success ? parsed.data.email : "invalid-input",
    );
  } catch (error) {
    if (error instanceof DomainError && error.code === "RATE_LIMITED")
      return null;
    throw error;
  }
  if (!parsed.success) return null;
  const user = await db.user.findUnique({
    where: { email: parsed.data.email },
    include: { employee: true },
  });
  const valid = await verifyPassword(user?.passwordHash, parsed.data.password);
  if (!valid || !user?.passwordHash || !isAccountEligible(user)) return null;
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
    },
    // Request-local verification proof only. The provider returns only the allowlisted user.
    proof: { email: user.email, passwordHash: user.passwordHash },
  };
}
