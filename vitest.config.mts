import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(
        new URL("./tests/server-only.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    // Suites share one disposable database. SERIALIZABLE predicate locks can
    // conflict across unrelated fixtures; concurrency tests still race their
    // operations explicitly within each suite.
    fileParallelism: !process.env.TEST_DATABASE_URL,
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],
  },
});
