import { describe, expect, it } from "vitest";
import {
  BRUNO_AGENT_ID_LABEL,
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
      args: ["sh", "-c", expect.stringContaining("bruno docker dummy runner started")],
    });
    expect(
      resolveDockerRunnerCommand({
        BRUNO_DOCKER_RUNNER_IMAGE: "bruno/hermes:test",
        BRUNO_DOCKER_RUNNER_ARGS_JSON: '["hermes","run","--agent-id","demo"]',
      }),
    ).toEqual({
      image: "bruno/hermes:test",
      args: ["hermes", "run", "--agent-id", "demo"],
    });
    expect(() =>
      resolveDockerRunnerCommand({
        BRUNO_DOCKER_RUNNER_ARGS_JSON: '"hermes run --agent-id demo"',
      }),
    ).toThrow("BRUNO_DOCKER_RUNNER_ARGS_JSON must be a JSON string array.");
  });

  it("builds plans without shell interpolation and parses timestamped Docker logs", () => {
    const plan = buildDockerRunPlan({
      agentId: "00000000-0000-4000-8000-000000000201",
      command: {
        image: "bruno/hermes:test",
        args: ["hermes", "run", "agent && echo unsafe"],
      },
      mounts: resolveDockerRunnerMounts({
        configPath: "/tmp/bruno/config.json",
        workspaceRoot: "/tmp/bruno/workspaces",
      }),
      nameSuffix: "unit001",
      resources: {
        cpus: "1",
        memory: "512m",
      },
    });

    expect(plan.args).toContain("agent && echo unsafe");
    expect(plan.args).toContain(
      "type=bind,source=/tmp/bruno/config.json,target=/etc/bruno/config-00000000-0000-4000-8000-000000000201,readonly",
    );
    expect(plan.args).toContain(
      "type=bind,source=/tmp/bruno/workspaces/00000000-0000-4000-8000-000000000201,target=/workspace",
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

  it("builds distinct runtime identifiers and mounts for three agents on one runner", () => {
    const agentIds = [
      "00000000-0000-4000-8000-000000000201",
      "00000000-0000-4000-8000-000000000202",
      "00000000-0000-4000-8000-000000000203",
    ];
    const plans = agentIds.map((agentId) =>
      buildDockerRunPlan({
        agentId,
        command: {
          image: "bruno/hermes:test",
          args: ["hermes", "run"],
        },
        mounts: resolveDockerRunnerMounts({
          configPath: "/tmp/bruno/config.json",
          workspaceRoot: "/tmp/bruno/workspaces",
        }),
        nameSuffix: "same-runner",
        resources: {
          cpus: "1",
          memory: "512m",
        },
      }),
    );
    const bindMounts = plans.flatMap((plan) =>
      plan.args.filter((arg) => arg.startsWith("type=bind")),
    );

    expect(new Set(plans.map((plan) => plan.containerName)).size).toBe(3);
    expect(new Set(plans.map((plan) => plan.workspacePath)).size).toBe(3);
    expect(new Set(plans.map((plan) => plan.configTargetPath)).size).toBe(3);
    expect(new Set(bindMounts).size).toBe(6);

    for (const [index, plan] of plans.entries()) {
      const agentId = agentIds[index];

      expect(plan.containerName).toBe(`bruno-${agentId}-same-runner`);
      expect(plan.workspacePath).toBe(`/tmp/bruno/workspaces/${agentId}`);
      expect(plan.configTargetPath).toBe(`/etc/bruno/config-${agentId}`);
      expect(plan.args).toContain(`${BRUNO_AGENT_ID_LABEL}=${agentId}`);
      expect(plan.args).toContain(`BRUNO_AGENT_ID=${agentId}`);
      expect(plan.args).toContain(`BRUNO_CONFIG_PATH=/etc/bruno/config-${agentId}`);
      expect(plan.args).toContain(
        `type=bind,source=/tmp/bruno/config.json,target=/etc/bruno/config-${agentId},readonly`,
      );
      expect(plan.args).toContain(
        `type=bind,source=/tmp/bruno/workspaces/${agentId},target=/workspace`,
      );
    }
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
