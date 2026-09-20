import { z } from "zod";
import { api, readJson } from "@/lib/api";
import { requireEmployee } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { deviceSelect, revokeOwnCredential } from "@/modules/webauthn/service";
import { paginationSchema } from "@/modules/management/validation";
export function GET(request: Request) {
  return api(async () => {
    const actor = await requireEmployee();
    const { page, pageSize } = paginationSchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const where = { employeeId: actor.employee.id };
    const [items, total] = await Promise.all([
      db.webAuthnCredential.findMany({
        where,
        select: deviceSelect,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: pageSize,
        skip: (page - 1) * pageSize,
      }),
      db.webAuthnCredential.count({ where }),
    ]);
    return { items, total, page, pageSize };
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
