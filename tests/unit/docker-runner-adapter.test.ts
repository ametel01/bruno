import { describe, expect, it } from "vitest";
import {
  buildDockerRunPlan,
  DEFAULT_DOCKER_RUNNER_IMAGE,
  parseDockerLogOutput,
  resolveDockerRunnerCommand,
  resolveDockerRunnerMounts,
} from "@/src/server/runners/docker-runner-adapter";
import {
  detectDockerAvailability,
  dockerUnavailableSkipReason,
} from "@/tests/helpers/docker-availability";

describe("Docker runner command configuration", () => {
  it("defaults to a deterministic dummy runner command and parses configured argv JSON", () => {
    expect(resolveDockerRunnerCommand({})).toMatchObject({
      image: DEFAULT_DOCKER_RUNNER_IMAGE,
      args: ["sh", "-c", expect.stringContaining("agentbay docker dummy runner started")],
    });
    expect(
      resolveDockerRunnerCommand({
        AGENTBAY_DOCKER_RUNNER_IMAGE: "agentbay/hermes:test",
        AGENTBAY_DOCKER_RUNNER_ARGS_JSON: '["hermes","run","--agent-id","demo"]',
      }),
    ).toEqual({
      image: "agentbay/hermes:test",
      args: ["hermes", "run", "--agent-id", "demo"],
    });
    expect(() =>
      resolveDockerRunnerCommand({
        AGENTBAY_DOCKER_RUNNER_ARGS_JSON: '"hermes run --agent-id demo"',
      }),
    ).toThrow("AGENTBAY_DOCKER_RUNNER_ARGS_JSON must be a JSON string array.");
  });

  it("builds plans without shell interpolation and parses timestamped Docker logs", () => {
    const plan = buildDockerRunPlan({
      agentId: "00000000-0000-4000-8000-000000000201",
      command: {
        image: "agentbay/hermes:test",
        args: ["hermes", "run", "agent && echo unsafe"],
      },
      mounts: resolveDockerRunnerMounts({
        configPath: "/tmp/agentbay/config.json",
        workspaceRoot: "/tmp/agentbay/workspaces",
      }),
      nameSuffix: "unit001",
      resources: {
        cpus: "1",
        memory: "512m",
      },
    });

    expect(plan.args).toContain("agent && echo unsafe");
    expect(plan.args).toContain(
      "type=bind,source=/tmp/agentbay/config.json,target=/etc/agentbay/config,readonly",
    );
    expect(plan.args).toContain(
      "type=bind,source=/tmp/agentbay/workspaces/00000000-0000-4000-8000-000000000201,target=/workspace",
    );
    expect(
      parseDockerLogOutput({
        stdout: "2026-07-04T08:00:01.000000000Z stdout line\n",
        stderr: "2026-07-04T08:00:02.000000000Z stderr line\n",
      }),
    ).toMatchObject([
      { stream: "stdout", message: "stdout line" },
      { stream: "stderr", message: "stderr line" },
    ]);
  });
});

describe("Docker runner external availability", () => {
  it("reports a clear skip reason for real Docker contract tests when Docker is unavailable", async () => {
    const availability = await detectDockerAvailability();
    const skipReason = dockerUnavailableSkipReason(availability);

    if (skipReason) {
      expect(skipReason).toContain("Skipping real Docker tests:");
    } else {
      expect(availability.available).toBe(true);
    }
  });
});
