import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPersistenceError } from "@/src/server/agents/create-agent";

const mocks = vi.hoisted(() => ({
  createAgentForDevelopmentUser: vi.fn(),
}));

vi.mock("@/src/server/agents/create-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/agents/create-agent")>();

  return {
    ...actual,
    createAgentForDevelopmentUser: mocks.createAgentForDevelopmentUser,
  };
});

describe("POST /api/agents route", () => {
  afterEach(() => {
    mocks.createAgentForDevelopmentUser.mockReset();
  });

  it("returns safe 201 JSON for a valid create-agent request", async () => {
    mocks.createAgentForDevelopmentUser.mockResolvedValueOnce({
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
    expect(mocks.createAgentForDevelopmentUser).toHaveBeenCalledWith({
      name: "Research Agent",
      templateKey: "research_agent",
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
    expect(mocks.createAgentForDevelopmentUser).not.toHaveBeenCalled();
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
    expect(mocks.createAgentForDevelopmentUser).not.toHaveBeenCalled();
  });

  it("returns a safe persistence error response", async () => {
    mocks.createAgentForDevelopmentUser.mockRejectedValueOnce(new AgentPersistenceError());
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

  it("returns a safe database unavailable response when Postgres cannot be reached", async () => {
    mocks.createAgentForDevelopmentUser.mockRejectedValueOnce(
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
    mocks.createAgentForDevelopmentUser.mockRejectedValueOnce(
      new AgentPersistenceError({ code: "42P01" }),
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
        code: "database_schema_missing",
        message: "Database schema is missing. Run migrations before creating agents.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });
});
