import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PORT ?? 3200);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: "./tests/e2e-hosted",
  fullyParallel: false,
  reporter: "list",
  workers: 1,
  use: {
    baseURL,
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  webServer: {
    command: `bun run dev --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "1",
    timeout: 120_000,
  },
  projects: [
    {
      name: "clerk setup",
      testMatch: /clerk-setup\.ts/,
    },
    {
      name: "clerk hosted",
      dependencies: ["clerk setup"],
      testMatch: /clerk-hosted\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
