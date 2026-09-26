import { z } from "zod";
import { api, readJson } from "@/lib/api";
import { requireEmployee } from "@/lib/auth";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { measureServerTiming, requestServerTiming } from "@/lib/server-timing";
import { authenticationOptions } from "@/modules/webauthn/service";
const inputSchema = z
  .object({ action: z.enum(["CHECK_IN", "CHECK_OUT"]) })
  .strict();
export async function POST(request: Request) {
  const timing = requestServerTiming(request);
  const response = await api(async () => {
    assertSameOrigin(request);
    const actor = await measureServerTiming(timing, "auth", requireEmployee);
    await measureServerTiming(timing, "rate_limit", () =>
      rateLimit(`passkey-authenticate:${actor.id}`, 15, 60),
    );
    return authenticationOptions(
      actor,
      (await readJson(request, inputSchema)).action,
      timing,
    );
  });
  return timing?.apply(response) ?? response;
}
