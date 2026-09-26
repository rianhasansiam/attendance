import { after } from "next/server";
import { api, readJson } from "@/lib/api";
import { DomainError } from "@/lib/errors";
import { assertSameOrigin } from "@/lib/security";
import { limitPasswordAction } from "@/modules/auth/auth-rate-limit";
import {
  FORGOT_PASSWORD_MESSAGE,
  requestPasswordReset,
} from "@/modules/auth/password-reset";
import { forgotPasswordSchema } from "@/modules/auth/password-validation";

export function POST(request: Request) {
  return api(async () => {
    assertSameOrigin(request);
    const input = await readJson(request, forgotPasswordSchema);
    try {
      await limitPasswordAction(request, "forgot", input.email);
      after(async () => {
        try {
          await requestPasswordReset(input);
        } catch {
          console.error("Password reset request could not be completed");
        }
      });
    } catch (error) {
      // Throttling and operational failures must have the same public response.
      if (!(error instanceof DomainError && error.code === "RATE_LIMITED"))
        console.error("Password reset request scheduling failed");
    }
    return { message: FORGOT_PASSWORD_MESSAGE };
  });
}
