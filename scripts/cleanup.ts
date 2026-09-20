import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
async function main() {
  try {
    const now = new Date();
    const counts = await db.$transaction([
      db.rateLimit.deleteMany({ where: { resetAt: { lt: now } } }),
      db.webAuthnChallenge.deleteMany({ where: { expiresAt: { lt: now } } }),
      db.session.deleteMany({ where: { expires: { lt: now } } }),
    ]);
    console.log(
      "Expired security state removed",
      counts.map((result) => result.count),
    );
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
