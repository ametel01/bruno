import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertLocalAgentCycleIsolation } from "@/scripts/smoke-local-agent-cycle";
import {
  LOCAL_AGENT_SMOKE_MODE_ENV,
  LOCAL_AGENT_SMOKE_MODE_VALUE,
  createLocalAgentSmokeBootReadiness,
  resolveLocalAgentSmokeMode,
} from "@/src/runner-service/local-agent-smoke";

describe("local full agent-cycle smoke", () => {
  it("accepts only the zero-cloud provider sentinel", () => {
    expect(() =>
      assertLocalAgentCycleIsolation({
        AGENTBAY_DIGITALOCEAN_PROVIDER_MODE: "local_docker",
        AGENTBAY_DIGITALOCEAN_TOKEN: "local-docker",
        [LOCAL_AGENT_SMOKE_MODE_ENV]: LOCAL_AGENT_SMOKE_MODE_VALUE,
      }),
    ).not.toThrow();

    for (const env of [
      {
        AGENTBAY_DIGITALOCEAN_PROVIDER_MODE: "digitalocean",
        AGENTBAY_DIGITALOCEAN_TOKEN: "local-docker",
        [LOCAL_AGENT_SMOKE_MODE_ENV]: LOCAL_AGENT_SMOKE_MODE_VALUE,
      },
      {
        AGENTBAY_DIGITALOCEAN_PROVIDER_MODE: "local_docker",
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_live",
        [LOCAL_AGENT_SMOKE_MODE_ENV]: LOCAL_AGENT_SMOKE_MODE_VALUE,
      },
    ]) {
      expect(() => assertLocalAgentCycleIsolation(env)).toThrow(/exact local_docker provider/);
    }
  });

  it("enables synthetic runner boundaries only on isolated host callbacks", () => {
    expect(resolveLocalAgentSmokeMode({})).toEqual({ enabled: false });
    expect(
      resolveLocalAgentSmokeMode({
        [LOCAL_AGENT_SMOKE_MODE_ENV]: LOCAL_AGENT_SMOKE_MODE_VALUE,
        AGENTBAY_APP_URL: "http://host.docker.internal:3000",
        AGENTBAY_RUNNER_ENDPOINT_URL: "http://127.0.0.1:3045",
      }),
    ).toMatchObject({ enabled: true });

    expect(() =>
      resolveLocalAgentSmokeMode({
        [LOCAL_AGENT_SMOKE_MODE_ENV]: LOCAL_AGENT_SMOKE_MODE_VALUE,
        AGENTBAY_APP_URL: "https://plingpling.example.com",
        AGENTBAY_RUNNER_ENDPOINT_URL: "http://host.docker.internal:3045",
      }),
    ).toThrow(/isolated local HTTP URL/);
  });

  it("replaces the redundant local boot fixture with a Docker-only readiness check", async () => {
    const readiness = createLocalAgentSmokeBootReadiness({
      docker: async () => ({ stdout: "27.0.0\n", stderr: "" }),
      now: () => new Date("2026-08-05T00:00:00.000Z"),
    });

    await readiness.start();

    expect(await readiness.read()).toMatchObject({
      status: "ready",
      components: {
        docker: "passed",
        hermesFixture: "passed",
        detailedHealth: "passed",
        modelCanary: "passed",
        telegramConfig: "passed",
        cleanup: "passed",
      },
    });
  });

  it("wires one simulated Droplet through real create, deployment, runtime, and cleanup services", async () => {
    const source = await readFile(
      join(process.cwd(), "scripts/smoke-local-agent-cycle.ts"),
      "utf8",
    );
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const compose = await readFile(join(process.cwd(), "compose.yaml"), "utf8");

    expect(packageJson.scripts["local:agent:smoke"]).toContain(
      "AGENTBAY_DIGITALOCEAN_PROVIDER_MODE=local_docker",
    );
    expect(packageJson.scripts["local:agent:smoke"]).toContain(
      "AGENTBAY_DIGITALOCEAN_TOKEN=local-docker",
    );
    expect(source).toContain("createAgentForUser");
    expect(source).toContain("reconcileTargetAgentDeployment");
    expect(source).toContain("restartAgentForUser");
    expect(source).toContain("reconcileTargetAgentRuntime");
    expect(source).toContain("buildHermesAgentLaunchSpecForUser");
    expect(source).toContain("stopAgentForUser");
    expect(source).toContain("deleteAgentForUser");
    expect(source).toContain("simulatedDroplets: 1");
    expect(source).toContain("digitalOceanRequests: 0");
    expect(source).toContain("hermesInstalledInsideDroplet: true");
    expect(source).toContain("hermesGatewayLiveInsideDroplet: true");
    expect(source).toContain("nestedDocker: true");
    expect(source).toContain("verifyHermesInsideDroplet");
    expect(source).toContain("assertNoRunningAgentContainersInsideDroplet");
    expect(source).toContain("/opt/hermes/bin/hermes");
    expect(source).toContain("/health/detailed");
    expect(source).toContain('"exec",\n    LOCAL_DOCKER_DROPLET_CONTAINER_NAME,\n    "docker"');
    expect(source).toContain("triggerReplacement: () => undefined");
    expect(source).toContain("refuses managed-runner replacement during smoke");
    expect(source).toContain('url.hostname = "127.0.0.1"');
    expect(source).toContain("manualRunnerAdapter: createHostRunnerAdapter");
    expect(source).toContain("runtime opened its recovery circuit");
    expect(source).toContain("assertNoManagedContainers");
    expect(source).toContain("assertNoAgentContainers");
    expect(source).toContain("control plane exited during startup");
    expect(source).toContain('compose(["down", "--volumes", "--remove-orphans"]');
    expect(compose.indexOf("bun run db:migrate")).toBeLessThan(
      compose.indexOf("bun run local:cloud:prepare"),
    );
    expect(compose).toContain("platform: linux/amd64");
    expect(compose).toContain("AGENTBAY_AGENT_SECRET_ACTIVE_KEY_VERSION");
    expect(compose).toContain("AGENTBAY_AGENT_SECRET_KEYS_JSON");
    expect(compose).toContain("AGENTBAY_HERMES_WORKLOAD_IMAGE");
  });
});
