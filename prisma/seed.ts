import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
const env = z
  .object({
    DATABASE_URL: z.string().url(),
    SEED_ADMIN_EMAIL: z.email().transform((s) => s.trim().toLowerCase()),
    SEED_ADMIN_NAME: z.string().min(1),
  })
  .parse(process.env);
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
async function main() {
  try {
    const existing = await db.user.findUnique({
      where: { email: env.SEED_ADMIN_EMAIL },
    });
    if (existing) {
      if (existing.role !== "SUPER_ADMIN" || existing.status !== "ACTIVE")
        throw new Error(
          "Existing account is not an active super administrator. Review manually; seed will not escalate accounts.",
        );
      console.log("Administrator already provisioned.");
    } else {
      await db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: env.SEED_ADMIN_EMAIL,
            name: env.SEED_ADMIN_NAME,
            role: "SUPER_ADMIN",
            status: "ACTIVE",
          },
        });
        await tx.auditLog.create({
          data: {
            action: "BOOTSTRAP_ADMIN",
            resource: "User",
            resourceId: user.id,
            newState: { role: "SUPER_ADMIN" },
          },
        });
      });
      console.log(
        "Administrator provisioned. Sign in using the matching Google account.",
      );
    }
  } finally {
    await db.$disconnect();
  }
}
void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Maintenance command failed",
  );
  process.exitCode = 1;
});
