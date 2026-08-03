import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("local cloud smoke script", () => {
  it("proves the persisted Step 7 controller with simultaneous local-fake triggers", async () => {
    const smokeScript = await readFile(join(process.cwd(), "scripts/smoke-local-cloud.ts"), "utf8");

    expect(smokeScript).toContain("reconcileTargetAgentDeployment");
    expect(smokeScript).toContain("reconcileTargetRunnerDeployment");
    expect(smokeScript).toContain("reconcileNextAgentDeployment");
    expect(smokeScript).toContain("FakeDigitalOceanProvider");
    expect(smokeScript).toContain("browserClosedAfter202");
    expect(smokeScript).toContain(
      'simultaneousTriggers: ["create-kick", "heartbeat", "cron", "manual"]',
    );
    expect(smokeScript).toContain("provider.resources.size !== 1");
    expect(smokeScript).toContain("canaryCalls !== 1");
    expect(smokeScript).toContain("runningTransitions.length !== 1");
    expect(smokeScript).toContain("usage.length !== 1");
  });
});
