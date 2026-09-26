import { api, readJson } from "@/lib/api";
import { assertSameOrigin } from "@/lib/security";
import { limitPasswordAction } from "@/modules/auth/auth-rate-limit";
import { resetPassword } from "@/modules/auth/password-reset";
import { resetPasswordSchema } from "@/modules/auth/password-validation";

export function POST(request: Request) {
  return api(async () => {
    assertSameOrigin(request);
    const input = await readJson(request, resetPasswordSchema);
    await limitPasswordAction(request, "reset", input.token);
    return resetPassword(input);
  });
}
