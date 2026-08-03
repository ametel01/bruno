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
      "bun --conditions react-server scripts/smoke-local-hermes-contract.ts",
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
    expect(smokeScript).toContain("restartedRunnerService.restart");
    expect(smokeScript).toContain("assertExactManagedRestartPolicy");
    expect(smokeScript).toContain('restartPolicy.name !== "unless-stopped"');
    expect(smokeScript).toContain("waitForDockerPolicyRecovery");
    expect(smokeScript).toContain("baselineRestartCount");
    expect(smokeScript).toContain("killSelectedContainerProcessFromDockerHost");
    expect(smokeScript).toContain('"{{.State.Pid}}"');
    expect(smokeScript).toContain('"--pid"');
    expect(smokeScript).toContain('"host"');
    expect(smokeScript).toContain('"--cap-add"');
    expect(smokeScript).toContain('"KILL"');
    expect(smokeScript).toContain("LOCAL_DOCKER_PID_HELPER_IMAGE");
    expect(smokeScript).toContain("const restartedRunnerService = createRunner()");
    expect(smokeScript).toContain('docker(["rm", "--force", policyRecoveredContainerId])');
    expect(smokeScript).toContain("waitForExactHermesReady");
    expect(smokeScript).toContain("assertOneSelectedContainer");
    expect(smokeScript).toContain("afterStoppedRunnerRestart");
    expect(smokeScript).toContain("restartedRunnerService.cleanup");
    expect(smokeScript).toContain("drivePersistedHermesController");
    expect(smokeScript).toContain("reconcileNextAgentDeployment");
    expect(smokeScript).toContain('deployment?.stage !== "ready"');
    expect(smokeScript).toContain('deployment.canaryState !== "passed"');
    expect(smokeScript).toContain("runningTransitions.length !== 1");
    expect(smokeScript).toContain('telegramBoundary: "local-fake-platform-state"');
    expect(smokeScript).toContain("dockerPolicyRecovery: true");
    expect(smokeScript).toContain("runnerProcessRestartObserved: true");
    expect(smokeScript).toContain("selectedAbsenceRecovered: true");
    expect(smokeScript).toContain("stoppedAcrossRunnerRestart: true");
  });
});
