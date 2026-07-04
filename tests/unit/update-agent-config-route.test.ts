import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateAgentConfigForDevelopmentUser: vi.fn(),
}));

vi.mock("@/src/server/agents/update-agent-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/agents/update-agent-config")>();

  return {
    ...actual,
    updateAgentConfigForDevelopmentUser: mocks.updateAgentConfigForDevelopmentUser,
  };
});

const AGENT_ID = "3e47bed7-b58f-4394-93c0-01e3d1e51774";

describe("PATCH /api/agents/[agentId] route", () => {
  afterEach(() => {
    mocks.updateAgentConfigForDevelopmentUser.mockReset();
  });

  it("returns safe JSON for a valid config update request", async () => {
    mocks.updateAgentConfigForDevelopmentUser.mockResolvedValueOnce({
      ok: true,
      noOp: false,
      agent: {
        id: AGENT_ID,
        userId: "f3fbda50-7269-4534-94d9-4819f1a38da7",
        name: "Research Agent",
        templateKey: "research_agent",
        status: "stopped",
        statusReason: null,
        createdAt: "2026-07-04T07:00:00.000Z",
        updatedAt: "2026-07-04T08:00:00.000Z",
        deletedAt: null,
      },
      config: {
        systemPrompt: "Keep answers concise.",
        modelProvider: "openai",
        modelName: "gpt-4.1-mini",
        maxDailySpendCents: 1234,
        scheduleMode: "manual",
        scheduleCron: null,
        timezone: "Asia/Manila",
        updatedAt: "2026-07-04T08:00:00.000Z",
      },
      changedFields: [
        { field: "modelName", before: "not_configured", after: "gpt-4.1-mini" },
        { field: "maxDailySpend", before: "$0.00", after: "$12.34" },
      ],
      event: {
        type: "config.updated",
      },
    });
    const { PATCH } = await import("@/app/api/agents/[agentId]/route");

    const response = await PATCH(
      new Request("http://localhost/api/agents/config", {
        method: "PATCH",
        body: JSON.stringify({
          modelName: "  gpt-4.1-mini  ",
          maxDailySpend: "12.34",
        }),
      }),
      {
        params: Promise.resolve({ agentId: AGENT_ID }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      noOp: false,
      config: {
        modelName: "gpt-4.1-mini",
        maxDailySpendCents: 1234,
      },
      event: {
        type: "config.updated",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
    expect(mocks.updateAgentConfigForDevelopmentUser).toHaveBeenCalledWith(AGENT_ID, {
      modelName: "gpt-4.1-mini",
      maxDailySpendCents: 1234,
    });
  });

  it("returns stable no-op JSON without changing event shape", async () => {
    mocks.updateAgentConfigForDevelopmentUser.mockResolvedValueOnce({
      ok: true,
      noOp: true,
      agent: {
        id: AGENT_ID,
        userId: "f3fbda50-7269-4534-94d9-4819f1a38da7",
        name: "Research Agent",
        templateKey: "research_agent",
        status: "stopped",
        statusReason: null,
        createdAt: "2026-07-04T07:00:00.000Z",
        updatedAt: "2026-07-04T07:00:00.000Z",
        deletedAt: null,
      },
      config: {
        systemPrompt: "Keep answers concise.",
        modelProvider: "not_configured",
        modelName: "not_configured",
        maxDailySpendCents: 0,
        scheduleMode: "manual",
        scheduleCron: null,
        timezone: "UTC",
        updatedAt: "2026-07-04T07:00:00.000Z",
      },
      changedFields: [],
      event: null,
    });
    const { PATCH } = await import("@/app/api/agents/[agentId]/route");

    const response = await PATCH(
      new Request("http://localhost/api/agents/config", {
        method: "PATCH",
        body: JSON.stringify({}),
      }),
      {
        params: Promise.resolve({ agentId: AGENT_ID }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      noOp: true,
      changedFields: [],
      event: null,
    });
  });

  it("returns validation JSON and does not update records for malformed JSON or invalid payloads", async () => {
    const { PATCH } = await import("@/app/api/agents/[agentId]/route");

    const malformedResponse = await PATCH(
      new Request("http://localhost/api/agents/config", {
        method: "PATCH",
        body: "{",
      }),
      {
        params: Promise.resolve({ agentId: AGENT_ID }),
      },
    );
    const invalidResponse = await PATCH(
      new Request("http://localhost/api/agents/config", {
        method: "PATCH",
        body: JSON.stringify({
          modelName: "",
          nested: {
            apiKey: "sk-live-should-not-appear",
          },
        }),
      }),
      {
        params: Promise.resolve({ agentId: AGENT_ID }),
      },
    );

    expect(malformedResponse.status).toBe(400);
    expect(await malformedResponse.json()).toMatchObject({
      error: {
        code: "validation_failed",
        issues: [{ field: "body", message: "Request body must be valid JSON." }],
      },
    });
    expect(invalidResponse.status).toBe(400);
    const invalidBody = await invalidResponse.json();
    expect(invalidBody).toMatchObject({
      error: {
        code: "validation_failed",
        issues: [{ field: "body" }],
      },
    });
    expect(JSON.stringify(invalidBody)).not.toContain("sk-live-should-not-appear");
    expect(mocks.updateAgentConfigForDevelopmentUser).not.toHaveBeenCalled();
  });

  it("returns validation JSON for malformed, missing, and invalid encoded agent IDs", async () => {
    mocks.updateAgentConfigForDevelopmentUser
      .mockResolvedValueOnce({ ok: false, reason: "malformed_agent_id" })
      .mockResolvedValueOnce({ ok: false, reason: "missing_agent_id" });
    const { PATCH } = await import("@/app/api/agents/[agentId]/route");

    const malformedResponse = await PATCH(
      new Request("http://localhost/api/agents/config", {
        method: "PATCH",
        body: JSON.stringify({ modelName: "gpt-4.1-mini" }),
      }),
      {
        params: Promise.resolve({ agentId: "not-a-uuid" }),
      },
    );
    const missingResponse = await PATCH(
      new Request("http://localhost/api/agents/config", {
        method: "PATCH",
        body: JSON.stringify({ modelName: "gpt-4.1-mini" }),
      }),
      {
        params: Promise.resolve({}),
      },
    );
    const malformedEncodedResponse = await PATCH(
      new Request("http://localhost/api/agents/config", {
        method: "PATCH",
        body: JSON.stringify({ modelName: "gpt-4.1-mini" }),
      }),
      {
        params: Promise.resolve({ agentId: "%E0%A4%A" }),
      },
    );

    expect(malformedResponse.status).toBe(400);
    expect(missingResponse.status).toBe(400);
    expect(malformedEncodedResponse.status).toBe(400);
    expect(await malformedEncodedResponse.json()).toEqual({
      error: {
        code: "validation_failed",
        message: "Agent ID must be a valid UUID.",
      },
    });
  });

  it("returns not found JSON for missing or soft-deleted agents", async () => {
    mocks.updateAgentConfigForDevelopmentUser
      .mockResolvedValueOnce({ ok: false, reason: "agent_not_found" })
      .mockResolvedValueOnce({ ok: false, reason: "agent_not_found" });
    const { PATCH } = await import("@/app/api/agents/[agentId]/route");

    const missingResponse = await PATCH(
      new Request("http://localhost/api/agents/config", {
        method: "PATCH",
        body: JSON.stringify({ modelName: "gpt-4.1-mini" }),
      }),
      {
        params: Promise.resolve({ agentId: "00000000-0000-4000-8000-000000000000" }),
      },
    );
    const softDeletedResponse = await PATCH(
      new Request("http://localhost/api/agents/config", {
        method: "PATCH",
        body: JSON.stringify({ modelName: "gpt-4.1-mini" }),
      }),
      {
        params: Promise.resolve({ agentId: AGENT_ID }),
      },
    );

    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toMatchObject({
      error: { code: "agent_not_found" },
    });
    expect(softDeletedResponse.status).toBe(404);
    expect(await softDeletedResponse.json()).toMatchObject({
      error: { code: "agent_not_found" },
    });
  });

  it("returns safe persistence error JSON without database URLs or driver details", async () => {
    const { AgentConfigUpdatePersistenceError } = await import(
      "@/src/server/agents/update-agent-config"
    );

    mocks.updateAgentConfigForDevelopmentUser.mockRejectedValueOnce(
      new AgentConfigUpdatePersistenceError({
        code: "23514",
        detail: "postgres://agentbay:secret@localhost stack trace token",
      }),
    );
    const { PATCH } = await import("@/app/api/agents/[agentId]/route");

    const response = await PATCH(
      new Request("http://localhost/api/agents/config", {
        method: "PATCH",
        body: JSON.stringify({ modelName: "gpt-4.1-mini" }),
      }),
      {
        params: Promise.resolve({ agentId: AGENT_ID }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "agent_config_update_failed",
        message: "Agent config could not be updated.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
    expect(JSON.stringify(body)).not.toContain("stack trace");
    expect(JSON.stringify(body)).not.toContain("token");
  });
});
