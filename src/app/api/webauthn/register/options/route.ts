import { api } from "@/lib/api";
import { requireEmployee } from "@/lib/auth";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { registrationOptions } from "@/modules/webauthn/service";
export function POST(request: Request) {
  return api(async () => {
    assertSameOrigin(request);
    const actor = await requireEmployee();
    await rateLimit(`passkey-register:${actor.id}`, 10, 300);
    return registrationOptions(actor);
  });
}
