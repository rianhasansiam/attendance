import "server-only";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalDb = globalThis as unknown as { attendanceDb?: PrismaClient };
function client() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const cached = globalDb.attendanceDb;
  // Next development reloads retain global state after Prisma regeneration.
  // Prisma's proxy does not support instanceof; its constructor identity does.
  if (cached?.constructor === PrismaClient) return cached;
  const current = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL,
      max: 10,
    }),
    log: [],
  });
  globalDb.attendanceDb = current;
  if (cached)
    // Retire the old pool without letting cleanup failures block new requests.
    void Promise.resolve()
      .then(() => cached.$disconnect())
      .catch(() => {});
  return current;
}
// Lazy construction permits generating a production bundle without embedding secrets.
export const db = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const instance = client();
    const value = Reflect.get(instance, property);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
