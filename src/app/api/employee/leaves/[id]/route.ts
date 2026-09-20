import { api } from "@/lib/api";
import { requireEmployee } from "@/lib/auth";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { idSchema } from "@/modules/management/validation";
import { cancelLeave } from "@/modules/management/workflows";

export function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return api(async () => {
    assertSameOrigin(request);
    const user = await requireEmployee();
    await rateLimit(`leave:${user.id}`, 10, 60);
    return cancelLeave(
      user.employee.id,
      idSchema.parse((await context.params).id),
    );
  });
}
