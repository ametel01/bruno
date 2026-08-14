import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentCreateBlockedError,
  AgentPersistenceError,
  AgentRunnerProvisioningError,
  AgentRunnerVerificationError,
  ReadyAgentCreationDisabledError,
  ReadyAgentValidationError,
  TelegramBotInUseError,
  TelegramValidationUnavailableError,
} from "@/src/server/agents/create-agent";
import { AgentSecretKeyringError } from "@/src/server/agents/agent-secrets";

const mocks = vi.hoisted(() => ({
  createAgentForUser: vi.fn(),
  requireConfiguredApplicationUser: vi.fn(),
}));

vi.mock("@/src/server/agents/create-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/agents/create-agent")>();

  return {
    ...actual,
    createAgentForUser: mocks.createAgentForUser,
  };
});

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireConfiguredApplicationUser,
}));

const USER_ID = "f3fbda50-7269-4534-94d9-4819f1a38da7";

describe("POST /api/agents route", () => {
  beforeEach(() => {
    mocks.requireConfiguredApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
  });

  afterEach(() => {
    mocks.createAgentForUser.mockReset();
    mocks.requireConfiguredApplicationUser.mockReset();
  });

  it("returns safe 201 JSON for a valid create-agent request", async () => {
    mocks.createAgentForUser.mockResolvedValueOnce({
      agent: {
        id: "3e47bed7-b58f-4394-93c0-01e3d1e51774",
        userId: "f3fbda50-7269-4534-94d9-4819f1a38da7",
        name: "Research Agent",
        templateKey: "research_agent",
        templateVersion: "1.0.0",
        templateSnapshotJson: {
          key: "research_agent",
          version: "1.0.0",
          name: "Research Agent",
          description:
            "Tracks a research question, gathers source notes, and produces concise summaries for later review.",
          defaultTools: ["Web search", "Notes", "Summaries"],
          defaultSchedule: "Manual",
          defaultSystemPrompt:
            "You are a Research Agent. Gather relevant information, keep source notes, and produce concise summaries. Do not take external actions or contact third parties. Ask for approval before using any integration or publishing output.",
          requiredIntegrations: [],
        },
        status: "stopped",
        statusReason: null,
        createdAt: "2026-07-03T05:00:00.000Z",
        updatedAt: "2026-07-03T05:00:00.000Z",
        deletedAt: null,
        runnerId: null,
      },
      event: {
        type: "agent.created",
      },
    });
    const { POST } = await import("@/app/api/agents/route");

    const response = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        body: JSON.stringify({ name: "Research Agent", templateKey: "research_agent" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      agent: {
        name: "Research Agent",
        templateKey: "research_agent",
        templateVersion: "1.0.0",
        status: "stopped",
        statusReason: null,
        deletedAt: null,
      },
      event: {
        type: "agent.created",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
    expect(mocks.createAgentForUser).toHaveBeenCalledWith(USER_ID, {
      name: "Research Agent",
      templateKey: "research_agent",
      runnerId: null,
    });
  });

  it("returns validation JSON and does not create records for invalid payloads", async () => {
    const { POST } = await import("@/app/api/agents/route");

    const response = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        body: JSON.stringify({ name: " ", templateKey: "unknown" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: "validation_failed",
        message: "Request validation failed.",
        issues: [{ field: "name" }, { field: "templateKey" }],
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
    expect(mocks.createAgentForUser).not.toHaveBeenCalled();
  });

  it("returns exact 202 JSON for a ready create-agent response", async () => {
    const scheduleDeploymentReconcile = vi.fn();
    const readyResponse = {
      agent: {
        id: "3e47bed7-b58f-4394-93c0-01e3d1e51774",
        userId: USER_ID,
        name: "Ready Agent",
        templateKey: "research_agent",
        templateVersion: "1.0.0",
        templateSnapshotJson: {
          key: "research_agent",
          version: "1.0.0",
          name: "Research Agent",
          description: "Tracks a research question.",
          defaultTools: [],
          defaultSchedule: "Manual",
          defaultSystemPrompt: "safe prompt",
          requiredIntegrations: [],
        },
        status: "stopped",
        desiredStatus: "running",
        statusReason: null,
        createdAt: "2026-08-03T05:00:00.000Z",
        updatedAt: "2026-08-03T05:00:00.000Z",
        deletedAt: null,
        runnerId: null,
        assistant: { id: "chatgpt", displayName: "ChatGPT" },
        telegramBot: { id: "123456", username: "Valid_bot" },
      },
      deployment: {
        id: "00000000-0000-4000-8000-000000000171",
        agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774",
        stage: "pending",
        configRevision: "cfg-1785722421000",
        attemptCount: 0,
        error: null,
        nextAttemptAt: null,
        startedAt: null,
        completedAt: null,
        failedAt: null,
        createdAt: "2026-08-03T05:00:00.000Z",
        updatedAt: "2026-08-03T05:00:00.000Z",
      },
    };
    mocks.createAgentForUser.mockImplementationOnce(async (_userId, _input, dependencies) => {
      dependencies?.onReadyDeploymentCommitted?.(readyResponse.deployment.id);
      return readyResponse;
    });
    const { POST } = await import("@/app/api/agents/route");

    const response = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        body: JSON.stringify({
          name: "Ready Agent",
          templateKey: "research_agent",
          launchMode: "ready",
          idempotencyKey: "Ready-Key_01",
        }),
      }),
      undefined,
      {
        scheduleDeploymentReconcile,
      },
    );
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      agent: {
        name: "Ready Agent",
        status: "stopped",
        desiredStatus: "running",
        assistant: { id: "chatgpt", displayName: "ChatGPT" },
        telegramBot: { id: "123456", username: "Valid_bot" },
      },
      deployment: { stage: "pending", attemptCount: 0 },
    });
    expect(body).not.toHaveProperty("event");
    expect(JSON.stringify(body)).not.toContain("sk-or-v1");
    expect(mocks.createAgentForUser).toHaveBeenCalledWith(
      USER_ID,
      {
        name: "Ready Agent",
        templateKey: "research_agent",
        runnerId: null,
        launchMode: "ready",
        idempotencyKey: "Ready-Key_01",
        assistant: undefined,
        modelApiKey: undefined,
        telegramBotToken: undefined,
        telegramAllowedUserIds: undefined,
      },
      { onReadyDeploymentCommitted: scheduleDeploymentReconcile },
    );
    expect(scheduleDeploymentReconcile).toHaveBeenCalledOnce();
    expect(scheduleDeploymentReconcile).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000171",
    );
  });

  it("returns validation JSON and does not create records for malformed JSON", async () => {
    const { POST } = await import("@/app/api/agents/route");

    const response = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        body: "{",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: "validation_failed",
        issues: [{ field: "body", message: "Request body must be valid JSON." }],
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
    expect(mocks.createAgentForUser).not.toHaveBeenCalled();
  });

  it("returns a safe persistence error response", async () => {
    mocks.createAgentForUser.mockRejectedValueOnce(new AgentPersistenceError());
    const { POST } = await import("@/app/api/agents/route");

    const response = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        body: JSON.stringify({ name: "Research Agent", templateKey: "research_agent" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "agent_create_failed",
        message: "Agent could not be created.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });

  it("maps ready create failures without leaking credentials or bot ownership", async () => {
    const { POST } = await import("@/app/api/agents/route");
    const readyRequest = () =>
      new Request("http://localhost/api/agents", {
        method: "POST",
        body: JSON.stringify({
          name: "Ready Agent",
          templateKey: "research_agent",
          launchMode: "ready",
          idempotencyKey: "Ready-Key_02",
        }),
      });
    const cases = [
      {
        error: new ReadyAgentValidationError([
          { field: "telegramBotToken", message: "Telegram bot token format is invalid." },
        ]),
        status: 400,
        code: "validation_failed",
      },
      {
        error: new ReadyAgentCreationDisabledError("disabled"),
        status: 503,
        code: "ready_agent_creation_disabled",
      },
      {
        error: new ReadyAgentCreationDisabledError("invalid_configuration"),
        status: 503,
        code: "ready_agent_creation_invalid_config",
      },
      {
        error: new ReadyAgentCreationDisabledError("cold_provisioning_halted"),
        status: 503,
        code: "cold_provisioning_halted",
      },
      {
        error: new TelegramValidationUnavailableError("telegram_validation_timeout"),
        status: 503,
        code: "telegram_validation_unavailable",
      },
      {
        error: new TelegramBotInUseError(),
        status: 409,
        code: "telegram_bot_in_use",
      },
      {
        error: new AgentSecretKeyringError(),
        status: 503,
        code: "agent_secret_configuration_invalid",
      },
    ];

    for (const testCase of cases) {
      mocks.createAgentForUser.mockRejectedValueOnce(testCase.error);
      const response = await POST(readyRequest());
      const body = await response.json();

      expect(response.status).toBe(testCase.status);
      expect(body.error.code).toBe(testCase.code);
      expect(JSON.stringify(body)).not.toContain("123456:abcdefghijklmnopqrstuvwxyz");
      expect(JSON.stringify(body)).not.toContain("sk-or-v1");
    }
  });

  it("returns a safe plan-limit response when creation is blocked", async () => {
    mocks.createAgentForUser.mockRejectedValueOnce(
      new AgentCreateBlockedError({
        ok: false,
        reason: "plan_limit_reached",
        currentAgents: 2,
        maxAgents: 2,
      }),
    );
    const { POST } = await import("@/app/api/agents/route");

    const response = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        body: JSON.stringify({ name: "Research Agent", templateKey: "research_agent" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: {
        code: "plan_limit_reached",
        message: "Agent plan limit reached.",
        currentAgents: 2,
        maxAgents: 2,
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });

  it("returns a safe runner-capacity response when creation is blocked", async () => {
    mocks.createAgentForUser.mockRejectedValueOnce(
      new AgentCreateBlockedError({
        ok: false,
        reason: "runner_capacity_reached",
        runner: {
          id: "00000000-0000-4000-8000-000000000158",
          kind: "manual_vps",
          status: "online",
          latestHeartbeatAt: "2026-07-06T04:01:00.000Z",
          capacity: {
            max_agents: 1,
            running_agents: 1,
            cpu_used_percent: 20,
            memory_used_mb: 128,
            memory_total_mb: 1024,
            disk_used_mb: 256,
            disk_total_mb: 2048,
          },
        },
      }),
    );
    const { POST } = await import("@/app/api/agents/route");

    const response = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        body: JSON.stringify({ name: "Research Agent", templateKey: "research_agent" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: {
        code: "runner_capacity_reached",
        message: "Runner capacity reached.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("00000000-0000-4000-8000-000000000158");
  });

  it("returns an actionable response when automatic runner provisioning is not configured", async () => {
    mocks.createAgentForUser.mockRejectedValueOnce(
      new AgentRunnerProvisioningError("provider_not_configured"),
    );
    const { POST } = await import("@/app/api/agents/route");

    const response = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        body: JSON.stringify({ name: "Research Agent", templateKey: "research_agent" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: {
        code: "runner_provisioning_not_configured",
        message:
          "Cloud runner provisioning is not configured. Add DigitalOcean and runner credentials, then try again.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("dop_v1");
  });

  it("fails closed when live runner eligibility cannot be verified", async () => {
    mocks.createAgentForUser.mockRejectedValueOnce(
      new AgentRunnerVerificationError("provider_check_failed"),
    );
    const { POST } = await import("@/app/api/agents/route");

    const response = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        body: JSON.stringify({ name: "Research Agent", templateKey: "research_agent" }),
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "runner_verification_unavailable",
        message: "Runner availability could not be verified safely. Try again shortly.",
      },
    });
  });

  it("returns a safe database unavailable response when Postgres cannot be reached", async () => {
    mocks.createAgentForUser.mockRejectedValueOnce(
      new AgentPersistenceError({ code: "ECONNREFUSED" }),
    );
    const { POST } = await import("@/app/api/agents/route");

    const response = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        body: JSON.stringify({ name: "Research Agent", templateKey: "research_agent" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: {
        code: "database_unavailable",
        message:
          "Database is unavailable. Start Postgres and run migrations before creating agents.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });

  it("returns a safe schema missing response when migrations have not run", async () => {
    mocks.createAgentForUser.mockRejectedValueOnce(new AgentPersistenceError({ code: "42P01" }));
    const { POST } = await import("@/app/api/agents/route");

    const response = await POST(
      new Request("http://localhost/api/agents", {
        method: "POST",
        body: JSON.stringify({ name: "Research Agent", templateKey: "research_agent" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: {
        code: "database_schema_missing",
        message: "Database schema is missing. Run migrations before creating agents.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });
});
