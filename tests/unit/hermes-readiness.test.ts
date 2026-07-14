import { describe, expect, it } from "vitest";
import {
  buildHermesSetupReadiness,
  hermesConfigurationBlocker,
} from "@/src/server/agents/hermes-readiness";
import type { AgentDetailConfig } from "@/src/server/agents/list-agents";
import type { AgentSecretStatus } from "@/src/server/agents/agent-secrets";
import type { AssignedManualRunnerStatusSummary } from "@/src/server/runners/manual-runner-status";

describe("Hermes setup readiness", () => {
  it("reports field-specific blockers until model, secrets, and runner are ready", () => {
    const readiness = buildHermesSetupReadiness({
      config: agentConfig({ modelProvider: "not_configured", modelName: "not_configured" }),
      secretStatuses: [],
      assignedRunner: null,
    });

    expect(readiness).toMatchObject({
      configurationReady: false,
      runnerReady: true,
      startReady: false,
      startDisabledReason:
        "Select OpenRouter as the model provider before starting this Hermes agent.",
    });
    expect(readiness.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "model_provider", status: "missing" }),
        expect.objectContaining({ id: "openrouter_api_key", status: "missing" }),
        expect.objectContaining({ id: "runner", status: "ready" }),
      ]),
    );
  });

  it("marks setup ready only when all Hermes requirements and runner capacity are ready", () => {
    const readiness = buildHermesSetupReadiness({
      config: agentConfig({
        modelProvider: "openrouter",
        modelName: "openai/gpt-4.1-mini",
      }),
      secretStatuses: activeSecretStatuses(),
      assignedRunner: assignedRunner({ capacityBlocker: null }),
    });

    expect(readiness).toMatchObject({
      configurationReady: true,
      runnerReady: true,
      startReady: true,
      startDisabledReason: null,
    });
    expect(readiness.requirements.every((requirement) => requirement.status === "ready")).toBe(
      true,
    );
  });

  it("blocks start readiness when the assigned cloud runner is not ready", () => {
    const readiness = buildHermesSetupReadiness({
      config: agentConfig({
        modelProvider: "openrouter",
        modelName: "openai/gpt-4.1-mini",
      }),
      secretStatuses: activeSecretStatuses(),
      assignedRunner: assignedRunner({ capacityBlocker: "runner_capacity_reached" }),
    });

    expect(readiness).toMatchObject({
      configurationReady: true,
      runnerReady: false,
      startReady: false,
      startDisabledReason: "Assigned runner is not fully ready yet.",
    });
  });

  it("returns safe lifecycle blockers for missing Hermes configuration", () => {
    expect(
      hermesConfigurationBlocker({
        modelProvider: "openrouter",
        modelName: "openai/gpt-4.1-mini",
        secretKinds: new Set(["openrouter_api_key", "telegram_bot_token"]),
      }),
    ).toBe("Configure Telegram allowed users before starting this Hermes agent.");

    expect(
      hermesConfigurationBlocker({
        modelProvider: "openrouter",
        modelName: "openai/gpt-4.1-mini",
        secretKinds: new Set([
          "openrouter_api_key",
          "telegram_bot_token",
          "telegram_allowed_users",
          "api_server_key",
        ]),
      }),
    ).toBeNull();
  });
});

function agentConfig(overrides: Partial<AgentDetailConfig> = {}): AgentDetailConfig {
  return {
    systemPrompt: "You are a test agent.",
    modelProvider: "not_configured",
    modelName: "not_configured",
    maxDailySpendCents: 0,
    scheduleMode: "manual",
    scheduleCron: null,
    timezone: "UTC",
    updatedAt: "2026-07-14T01:00:00.000Z",
    ...overrides,
  };
}

function activeSecretStatuses(): AgentSecretStatus[] {
  return [
    secretStatus("openrouter_api_key"),
    secretStatus("telegram_bot_token"),
    secretStatus("telegram_allowed_users"),
    secretStatus("api_server_key"),
  ];
}

function secretStatus(kind: AgentSecretStatus["kind"]): AgentSecretStatus {
  return {
    kind,
    configured: true,
    fingerprint: "0123456789abcdef",
    status: "active",
    createdAt: "2026-07-14T01:00:00.000Z",
    updatedAt: "2026-07-14T01:00:00.000Z",
    rotatedAt: null,
    revokedAt: null,
  };
}

function assignedRunner(input: {
  capacityBlocker: AssignedManualRunnerStatusSummary["capacity"]["blocker"];
}): AssignedManualRunnerStatusSummary {
  return {
    name: "Hermes Runner",
    kind: "digitalocean",
    endpointHost: "runner.example.com",
    status: "online",
    capacity: {
      runningAgents: 0,
      maxAgents: 2,
      cpuUsedPercent: 10,
      memoryUsedMb: 512,
      memoryTotalMb: 2048,
      diskUsedMb: null,
      diskTotalMb: null,
      blocker: input.capacityBlocker,
    },
    version: "agentbay-runner/2.3.0",
    lastSeenAt: "2026-07-14T01:00:00.000Z",
    updatedAt: "2026-07-14T01:00:00.000Z",
    provisioningStatus: "ready",
    assignmentNotice: "This agent is assigned to Hermes Runner.",
    alertState: null,
    alertMessage: null,
  };
}
