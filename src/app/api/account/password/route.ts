import { api, readJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { limitPasswordAction } from "@/modules/auth/auth-rate-limit";
import { saveOwnPassword } from "@/modules/auth/password-management";
import { passwordChangeSchema } from "@/modules/auth/password-validation";

export function GET() {
  return api(async () => {
    const actor = await requireUser();
    return { hasPassword: actor.hasPassword };
  });
}

export function POST(request: Request) {
  return api(async () => {
    assertSameOrigin(request);
    const actor = await requireUser();
    await limitPasswordAction(request, "manage", actor.id);
    return saveOwnPassword(
      actor,
      await readJson(request, passwordChangeSchema),
    );
  });
}
