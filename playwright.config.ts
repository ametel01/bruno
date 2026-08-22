import { defineConfig, devices } from "@playwright/test";
import { resolveAuthMode } from "./src/auth/auth-mode";

const port = Number(process.env.PORT ?? 3000);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`;
const artifactPolicy = resolvePlaywrightArtifactPolicy(process.env);

export function resolvePlaywrightArtifactPolicy(env: Record<string, string | undefined>) {
  const authMode = resolveAuthMode(env);

  return {
    screenshot: "off",
    trace: authMode.mode === "development" ? "on-first-retry" : "off",
    video: "off",
  } as const;
}

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: [
    "founder-product-contract.spec.ts",
    "founder-product-contract-lifecycle.spec.ts",
    "founder-product-contract-failure.spec.ts",
  ],
  fullyParallel: false,
  reporter: "list",
  workers: 1,
  use: {
    baseURL,
    ...artifactPolicy,
  },
  webServer: {
    command: `BRUNO_READY_AGENT_CREATION_ENABLED=true bun run dev --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "1",
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium-mobile",
      use: { ...devices["Pixel 5"] },
    },
  ],
});
