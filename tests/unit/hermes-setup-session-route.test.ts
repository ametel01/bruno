import { describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/agents/[agentId]/hermes-setup-session/route";
import type { AgentDetail } from "@/src/server/agents/list-agents";
import type { DatabaseConnection } from "@/src/server/db/client";
import type { ManualRunnerRecord } from "@/src/server/runners/manual-runner-persistence";

const AGENT_ID = "00000000-0000-4000-8000-000000000123";
const USER_ID = "00000000-0000-4000-8000-000000000456";

describe("Hermes setup session route", () => {
  it("authorizes ownership, assigns a runner, and returns a browser-safe websocket session", async () => {
    const runner = sampleRunner();
    const getAssignedRunner = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(runner);
    const fetchRunner = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      expect(String(request)).toBe(
        `https://runner.example.com/runner/v1/agents/${AGENT_ID}/setup-sessions`,
      );
      expect(init?.headers).toMatchObject({ Authorization: "Bearer runner-control-token" });
      return Response.json(
        {
          ok: true,
          session: {
            id: "00000000-0000-4000-8000-000000000789",
            websocketPath: "/runner/v1/hermes-setup-sessions/00000000-0000-4000-8000-000000000789",
            websocketProtocol: "bruno.hermes.setup.one-time-token",
            expiresAt: "2026-07-14T06:00:00.000Z",
          },
        },
        { status: 201 },
      );
    });
    const response = await POST(
      new Request("https://app.example.com"),
      { params: Promise.resolve({ agentId: AGENT_ID }) },
      {
        createConnection: () => ({}) as DatabaseConnection,
        requireApplicationUser: async () => ({ ok: true, userId: USER_ID }),
        getAgent: async () => sampleAgent("stopped"),
        getAssignedRunner,
        assignRunner: async () => ({ ok: true, runnerId: runner.id }),
        listSecretStatuses: async () => ({
          ok: true,
          secrets: [activeApiServerKeyStatus()],
        }),
        env: { BRUNO_RUNNER_BEARER_TOKEN: "runner-control-token" },
        fetch: fetchRunner as typeof fetch,
      },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      session: {
        id: "00000000-0000-4000-8000-000000000789",
        websocketUrl:
          "wss://runner.example.com/runner/v1/hermes-setup-sessions/00000000-0000-4000-8000-000000000789",
        websocketProtocol: "bruno.hermes.setup.one-time-token",
        expiresAt: "2026-07-14T06:00:00.000Z",
      },
    });
    expect(getAssignedRunner).toHaveBeenCalledTimes(2);
    expect(fetchRunner).toHaveBeenCalledOnce();
  });

  it("generates the private API key without accepting a key from the browser", async () => {
    const generateApiServerKey = vi.fn(async () => ({
      ok: true as const,
      secret: activeApiServerKeyStatus(),
    }));
    const response = await POST(
      new Request("https://app.example.com", { method: "POST", body: "ignored" }),
      { params: Promise.resolve({ agentId: AGENT_ID }) },
      {
        createConnection: () => ({}) as DatabaseConnection,
        requireApplicationUser: async () => ({ ok: true, userId: USER_ID }),
        getAgent: async () => sampleAgent("stopped"),
        getAssignedRunner: async () => sampleRunner(),
        listSecretStatuses: async () => ({ ok: true, secrets: [] }),
        generateApiServerKey,
        env: { BRUNO_RUNNER_BEARER_TOKEN: "runner-control-token" },
        fetch: async () =>
          Response.json(
            {
              ok: true,
              session: {
                id: "00000000-0000-4000-8000-000000000789",
                websocketPath:
                  "/runner/v1/hermes-setup-sessions/00000000-0000-4000-8000-000000000789",
                websocketProtocol: "bruno.hermes.setup.one-time-token",
                expiresAt: "2026-07-14T06:00:00.000Z",
              },
            },
            { status: 201 },
          ),
      },
    );

    expect(response.status).toBe(201);
    expect(generateApiServerKey).toHaveBeenCalledWith(
      USER_ID,
      AGENT_ID,
      expect.objectContaining({ createConnection: expect.any(Function) }),
    );
  });

  it("refuses setup while the agent is running", async () => {
    const fetchRunner = vi.fn();
    const response = await POST(
      new Request("https://app.example.com"),
      { params: Promise.resolve({ agentId: AGENT_ID }) },
      {
        createConnection: () => ({}) as DatabaseConnection,
        requireApplicationUser: async () => ({ ok: true, userId: USER_ID }),
        getAgent: async () => sampleAgent("running"),
        fetch: fetchRunner as typeof fetch,
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "agent_running" },
    });
    expect(fetchRunner).not.toHaveBeenCalled();
  });
});

function sampleAgent(status: "stopped" | "running"): AgentDetail {
  return {
    id: AGENT_ID,
    name: "Hermes setup agent",
    templateKey: "research_agent",
    templateVersion: "1.0.0",
    templateLabel: "Research Agent",
    status,
    statusReason: null,
    href: `/agents/${AGENT_ID}`,
    createdAt: "2026-07-14T05:00:00.000Z",
    updatedAt: "2026-07-14T05:00:00.000Z",
    templateSnapshot: {
      key: "research_agent",
      version: "1.0.0",
      name: "Research Agent",
      description: "Research",
      systemPrompt: "Research carefully.",
      modelProvider: "not_configured",
      modelName: "not_configured",
      scheduleMode: "manual" as const,
      scheduleCron: null,
      timezone: "UTC",
    },
    config: {
      systemPrompt: "Research carefully.",
      modelProvider: "not_configured",
      modelName: "not_configured",
      maxDailySpendCents: 0,
      scheduleMode: "manual" as const,
      scheduleCron: null,
      timezone: "UTC",
      updatedAt: "2026-07-14T05:00:00.000Z",
    },
  } as unknown as AgentDetail;
}

function sampleRunner(): ManualRunnerRecord {
  return {
    id: "00000000-0000-4000-8000-000000000999",
    userId: USER_ID,
    name: "Cloud runner",
    kind: "digitalocean",
    endpointUrl: "https://runner.example.com",
    status: "online",
    createdAt: "2026-07-14T05:00:00.000Z",
    updatedAt: "2026-07-14T05:00:00.000Z",
    deletedAt: null,
  };
}

function activeApiServerKeyStatus() {
  return {
    kind: "api_server_key" as const,
    configured: true,
    fingerprint: "0123456789abcdef",
    status: "active" as const,
    createdAt: "2026-07-14T05:00:00.000Z",
    updatedAt: "2026-07-14T05:00:00.000Z",
    rotatedAt: null,
    revokedAt: null,
  };
}
