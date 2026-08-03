import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const REQUEST_SURFACES = [
  {
    file: "app/agents/page.tsx",
    required: [
      "requireConfiguredApplicationUser",
      "listActiveAgentsForUser",
      "listAssignableRunnersForUser",
      "listCloudRunnerProvisioningSummariesForUser",
    ],
  },
  {
    file: "app/agents/[agentId]/page.tsx",
    required: ["requireConfiguredApplicationUser", "getActiveAgentForUser"],
  },
  {
    file: "app/dashboard/page.tsx",
    required: ["requireConfiguredApplicationUser", "getCostEstimatesForUser"],
  },
  {
    file: "app/api/agents/route.ts",
    required: ["requireConfiguredApplicationUser", "createAgentForUser"],
  },
  {
    file: "app/api/agents/[agentId]/route.ts",
    required: [
      "requireConfiguredApplicationUser",
      "updateAgentConfigForUser",
      "deleteAgentForUser",
    ],
  },
  ...["start", "stop", "restart", "simulate-error"].map((action) => ({
    file: `app/api/agents/[agentId]/actions/${action}/route.ts`,
    required: ["requireConfiguredApplicationUser", `${toCamelCase(action)}AgentForUser`],
  })),
  {
    file: "app/api/agents/[agentId]/events/route.ts",
    required: ["requireConfiguredApplicationUser", "listAgentEventFeedForUser"],
  },
  {
    file: "app/api/agents/[agentId]/deployment/route.ts",
    required: ["requireConfiguredApplicationUser", "getLatestAgentDeploymentForUser"],
  },
  {
    file: "app/api/agents/[agentId]/logs/route.ts",
    required: [
      "requireConfiguredApplicationUser",
      "getActiveAgentForUser",
      "getAssignedRunnerForActiveAgentForUser",
      "getLifecycleRunnerAdapterForUser",
      "listAgentLogsForUser",
    ],
  },
] as const;

describe("agent request user boundaries", () => {
  for (const surface of REQUEST_SURFACES) {
    it(`${surface.file} resolves and forwards an explicit request user`, async () => {
      const source = await readFile(surface.file, "utf8");

      expect(source).not.toMatch(/get(?:OrCreate)?DevelopmentUser/);
      expect(source).not.toContain("ForDevelopmentUser");

      for (const required of surface.required) {
        expect(source).toContain(required);
      }
    });
  }

  it("binds runtime adapter persistence to the already-resolved owner", async () => {
    const sources = await Promise.all(
      [
        "src/server/agents/lifecycle.ts",
        "src/server/runners/docker-runner-adapter.ts",
        "src/server/runners/docker-runner-maintenance.ts",
        "src/server/runners/manual-runner-adapter.ts",
        "src/server/runners/local-runner-adapter.ts",
      ].map((file) => readFile(file, "utf8")),
    );
    const combined = sources.join("\n");

    for (const explicitSeam of [
      "getLifecycleRunnerAdapterForUser",
      "recordDockerRunnerContainerForUser",
      "getDockerRunnerContainerForUser",
      "appendDockerRunnerLogLinesForUser",
      "listDockerRunnerContainerLogsForUser",
      "appendManualRunnerLogLinesForUser",
      "listManualRunnerLogsForUser",
      "createLocalRunnerProcessForUser",
      "recordLocalRunnerProcessExitForUser",
      "appendLocalRunnerLogLinesForUser",
      "listLocalRunnerProcessLogsForUser",
    ]) {
      expect(combined).toContain(explicitSeam);
    }
  });
});

function toCamelCase(value: string) {
  return value.replace(/-([a-z])/g, (_match, character: string) => character.toUpperCase());
}
