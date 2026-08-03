import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("local Hermes contract smoke", () => {
  it("keeps a credential-free real-image end-to-end smoke command", async () => {
    const smokeScript = await readFile(
      join(process.cwd(), "scripts/smoke-local-hermes-contract.ts"),
      "utf8",
    );
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["agent:hermes:contract-smoke"]).toBe(
      "bun scripts/smoke-local-hermes-contract.ts",
    );
    expect(smokeScript).toContain("FAKE_MODEL_ALIAS");
    expect(smokeScript).toContain("model_routes");
    expect(smokeScript).toContain("/v1/chat/completions");
    expect(smokeScript).toContain("/health/detailed");
    expect(smokeScript).toContain("createHermesReadinessWaiter");
    expect(smokeScript).toContain("requireTelegram: true");
    expect(smokeScript).toContain("withLocalFakeTelegramHealth");
    expect(smokeScript).toContain("assertPrivateApiAuth");
    expect(smokeScript).toContain("assertNoPublicHermesPort");
    expect(smokeScript).toContain("waitForHermesGatewayLogs");
    expect(smokeScript).toContain("backupRestored");
    expect(smokeScript).toContain("runner.restart");
    expect(smokeScript).toContain("runner.cleanup");
    expect(smokeScript).toContain('telegramBoundary: "local-fake-platform-state"');
  });
});
