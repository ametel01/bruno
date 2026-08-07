import { defineConfig, devices } from "@playwright/test";
import { parsePlaywrightBaseUrl } from "@/src/testing/playwright-base-url";

const port = Number(process.env.PORT ?? 3200);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`;
const baseOrigin = parsePlaywrightBaseUrl(baseURL).origin;
const operatorUsername = process.env.AGENTBAY_OPERATOR_USERNAME?.trim();
const operatorPassword = process.env.AGENTBAY_OPERATOR_PASSWORD;
const httpCredentials =
  operatorUsername && operatorPassword
    ? { username: operatorUsername, password: operatorPassword, origin: baseOrigin }
    : undefined;

export default defineConfig({
  testDir: "./tests/e2e-hosted",
  fullyParallel: false,
  reporter: "list",
  workers: 1,
  use: {
    baseURL,
    httpCredentials,
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  webServer: {
    command: `bun run dev --hostname localhost --port ${port}`,
    env: {
      ...process.env,
      NEXT_PUBLIC_APP_URL: baseURL,
    },
    url: baseURL,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "1",
    timeout: 120_000,
  },
  projects: [
    {
      name: "clerk hosted",
      testMatch: /clerk-hosted\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
