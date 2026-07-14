import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4317",
    locale: "ar-EG",
    screenshot: "only-on-failure",
    trace: "off",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "rm -rf .tmp/e2e && npm run build && npm run app:test",
    url: "http://127.0.0.1:4317/api/bootstrap",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
