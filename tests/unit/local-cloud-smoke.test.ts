import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("local cloud smoke script", () => {
  it("proves persisted deployment and runtime controllers with simultaneous local-fake triggers", async () => {
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
    expect(smokeScript).toContain("reconcileTargetAgentRuntime");
    expect(smokeScript).toContain("reconcileTargetRunnerRuntime");
    expect(smokeScript).toContain("reconcileNextAgentRuntime");
    expect(smokeScript).toContain('runtimeFault = "telegram-fatal"');
    expect(smokeScript).toContain('return "nonempty"');
    expect(smokeScript).toContain('circuitRuntime?.state !== "circuit_open"');
    expect(smokeScript).toContain("stopAgentForUser");
    expect(smokeScript).toContain("startAgentForUser");
    expect(smokeScript).toContain("publicCircuitReset.state");
    expect(smokeScript).toContain("publicStop.agent.status");
    expect(smokeScript).toContain('stoppedRuntime?.state !== "stopped"');
    expect(smokeScript).toContain("runtimeUsage.length !== 5");
    expect(smokeScript).toContain("runtimeRecoveryEvents.length !== 1");
    expect(smokeScript).toContain("runtimeCircuitEvents.length !== 1");
    expect(smokeScript).toContain("runtimeStarts !== 4");
    expect(smokeScript).toContain("runtimeStops !== 5");
    expect(smokeScript).toContain('runtimeFault = "docker-daemon-restart"');
    expect(smokeScript).toContain("usageAfterDockerDaemonRestart.length !== 1");
    expect(smokeScript).toContain("dockerDaemonRestartObserved: true");
    expect(smokeScript).toContain(
      'runtimeFaultsRecovered: ["missing", "exited", "revision", "restart-policy"]',
    );
    expect(smokeScript).toContain('telegramBoundary: "injected-webhook-conflict"');
  });
});
