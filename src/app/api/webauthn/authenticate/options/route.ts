import { z } from "zod";
import { api, readJson } from "@/lib/api";
import { requireEmployee } from "@/lib/auth";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { authenticationOptions } from "@/modules/webauthn/service";
const inputSchema = z
  .object({ action: z.enum(["CHECK_IN", "CHECK_OUT"]) })
  .strict();
export function POST(request: Request) {
  return api(async () => {
    assertSameOrigin(request);
    const actor = await requireEmployee();
    await rateLimit(`passkey-authenticate:${actor.id}`, 15, 60);
    return authenticationOptions(
      actor,
      (await readJson(request, inputSchema)).action,
    );
  });
}
