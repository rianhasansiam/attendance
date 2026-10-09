import { defineConfig, devices } from "@playwright/test";

// Uses an existing local preview only. No database fixtures or server mutations.
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "homepage.spec.ts",
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env.XHYD_PREVIEW_URL || "http://localhost:3000",
    trace: "retain-on-failure",
  },
});
