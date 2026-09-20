import "dotenv/config";
import { defineConfig } from "prisma/config";

function migrationDatabaseUrl(connectionString: string | undefined) {
  if (!connectionString) return connectionString;
  const url = new URL(connectionString);
  if (!url.hostname.endsWith(".neon.tech")) return connectionString;
  const hostname = url.hostname.replace(/^([^.]+)-pooler\./, "$1.");
  if (hostname === url.hostname) return connectionString;
  url.hostname = hostname;
  return url.toString();
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" },
  // Use Neon's direct endpoint for CLI operations, preserving DATABASE_URL overrides.
  datasource: { url: migrationDatabaseUrl(process.env.DATABASE_URL) },
});
