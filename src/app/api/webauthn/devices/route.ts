import { z } from "zod";
import { api, readJson } from "@/lib/api";
import { requireEmployee } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { deviceSelect, revokeOwnCredential } from "@/modules/webauthn/service";
export function GET() {
  return api(async () => {
    const actor = await requireEmployee();
    return db.webAuthnCredential.findMany({
      where: { employeeId: actor.employee.id },
      select: deviceSelect,
      orderBy: { createdAt: "desc" },
    });
  });
}
export function DELETE(request: Request) {
  return api(async () => {
    assertSameOrigin(request);
    const actor = await requireEmployee();
    await rateLimit(`device-revoke:${actor.id}`, 10, 60);
    return revokeOwnCredential(
      actor,
      (
        await readJson(
          request,
          z.object({ id: z.string().min(1).max(100) }).strict(),
        )
      ).id,
    );
  });
}
