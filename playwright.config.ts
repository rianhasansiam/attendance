import { defineConfig, devices } from "@playwright/test";
const database = process.env.TEST_DATABASE_URL;
if (!database || !new URL(database).pathname.includes("test"))
  throw new Error(
    "Browser tests require TEST_DATABASE_URL pointing to a disposable database with 'test' in its name.",
  );
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "pnpm exec next dev --hostname 127.0.0.1 --port 3100",
    url: "http://localhost:3100/login",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_TEST_DIST_DIR: ".next-e2e",
      DATABASE_URL: database,
      AUTH_SECRET: "e2e-only-auth-secret-never-for-production-1234567890",
      AUTH_URL: "http://localhost:3100",
      GOOGLE_CLIENT_ID: "e2e-client",
      GOOGLE_CLIENT_SECRET: "e2e-secret",
      WEBAUTHN_RP_ID: "localhost",
      WEBAUTHN_RP_NAME: "Attendance tests",
      WEBAUTHN_ORIGIN: "http://localhost:3100",
      TRUSTED_PROXY_MODE: "none",
      ALLOWED_GOOGLE_DOMAIN: "",
    },
  },
});
