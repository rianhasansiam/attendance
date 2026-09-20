import { api, readJson } from "@/lib/api";
import { requireEmployee } from "@/lib/auth";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { registerCredential } from "@/modules/webauthn/service";
import { registrationInputSchema } from "@/modules/webauthn/validation";
export function POST(request: Request) {
  return api(async () => {
    assertSameOrigin(request);
    const actor = await requireEmployee();
    await rateLimit(`passkey-verify:${actor.id}`, 15, 300);
    return registerCredential(
      actor,
      await readJson(request, registrationInputSchema),
    );
  });
}
