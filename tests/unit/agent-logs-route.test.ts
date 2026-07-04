import { afterEach, describe, expect, it, vi } from "vitest";

const ACTIVE_AGENT_ID = "00000000-0000-4000-8000-000000000201";

const mocks = vi.hoisted(() => {
  class AgentDetailPersistenceError extends Error {
    constructor() {
      super("Agent detail failed.");
      this.name = "AgentDetailPersistenceError";
    }
  }

  return {
    AgentDetailPersistenceError,
    close: vi.fn(),
    createDatabaseConnection: vi.fn(),
    getActiveAgentForDevelopmentUser: vi.fn(),
    listAgentLogs: vi.fn(),
  };
});

vi.mock("@/src/server/db/client", () => ({
  createDatabaseConnection: mocks.createDatabaseConnection,
}));

vi.mock("@/src/server/agents/list-agents", () => ({
  AgentDetailPersistenceError: mocks.AgentDetailPersistenceError,
  getActiveAgentForDevelopmentUser: mocks.getActiveAgentForDevelopmentUser,
}));

vi.mock("@/src/server/logs/agent-logs", () => ({
  listAgentLogs: mocks.listAgentLogs,
}));

describe("GET /api/agents/[agentId]/logs route", () => {
  afterEach(() => {
    mocks.close.mockReset();
    mocks.createDatabaseConnection.mockReset();
    mocks.getActiveAgentForDevelopmentUser.mockReset();
    mocks.listAgentLogs.mockReset();
  });

  it("returns active-agent log DTO pages and passes bounded pagination to the log helper", async () => {
    mocks.createDatabaseConnection.mockReturnValue({ db: "db", close: mocks.close });
    mocks.getActiveAgentForDevelopmentUser.mockResolvedValue({
      id: ACTIVE_AGENT_ID,
    });
    mocks.listAgentLogs.mockResolvedValue({
      logs: [logDto(1), logDto(2)],
      nextAfter: 2,
    });
    const { GET } = await import("@/app/api/agents/[agentId]/logs/route");

    const response = await GET(
      new Request("http://localhost/api/agents/id/logs?limit=500&after=0"),
      {
        params: Promise.resolve({ agentId: ACTIVE_AGENT_ID }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      logs: [logDto(1), logDto(2)],
      nextAfter: 2,
    });
    expect(mocks.getActiveAgentForDevelopmentUser).toHaveBeenCalledWith(ACTIVE_AGENT_ID, {
      createConnection: expect.any(Function),
    });
    expect(mocks.listAgentLogs).toHaveBeenCalledWith({
      db: "db",
      agentId: ACTIVE_AGENT_ID,
      after: 0,
      limit: 100,
    });
    expect(JSON.stringify(body)).not.toContain("agent_id");
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "missing", agentId: undefined },
    { name: "malformed", agentId: "not-a-uuid" },
    { name: "malformed percent-encoded", agentId: "%E0%A4%A" },
  ])("returns validation JSON for $name agent IDs", async ({ agentId }) => {
    const { GET } = await import("@/app/api/agents/[agentId]/logs/route");

    const response = await GET(new Request("http://localhost/api/agents/id/logs"), {
      params: Promise.resolve(agentId === undefined ? {} : { agentId }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "validation_failed",
        message: "Agent ID must be a valid UUID.",
      },
    });
    expect(mocks.createDatabaseConnection).not.toHaveBeenCalled();
    expect(mocks.listAgentLogs).not.toHaveBeenCalled();
  });

  it.each([
    "-1",
    "1.5",
    "many",
    "9007199254740992",
  ])("returns validation JSON for invalid after %s", async (after) => {
    const { GET } = await import("@/app/api/agents/[agentId]/logs/route");

    const response = await GET(new Request(`http://localhost/api/agents/id/logs?after=${after}`), {
      params: Promise.resolve({ agentId: ACTIVE_AGENT_ID }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "validation_failed",
        message: "After must be a non-negative safe integer.",
      },
    });
    expect(mocks.createDatabaseConnection).not.toHaveBeenCalled();
  });

  it.each([
    "0",
    "-1",
    "1.5",
    "many",
    "9007199254740992",
  ])("returns validation JSON for invalid limit %s", async (limit) => {
    const { GET } = await import("@/app/api/agents/[agentId]/logs/route");

    const response = await GET(new Request(`http://localhost/api/agents/id/logs?limit=${limit}`), {
      params: Promise.resolve({ agentId: ACTIVE_AGENT_ID }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "validation_failed",
        message: "Limit must be a positive integer.",
      },
    });
    expect(mocks.createDatabaseConnection).not.toHaveBeenCalled();
  });

  it("rejects repeated after and limit query parameters before opening the database", async () => {
    const { GET } = await import("@/app/api/agents/[agentId]/logs/route");

    const repeatedAfterResponse = await GET(
      new Request("http://localhost/api/agents/id/logs?after=1&after=2"),
      {
        params: Promise.resolve({ agentId: ACTIVE_AGENT_ID }),
      },
    );
    const repeatedLimitResponse = await GET(
      new Request("http://localhost/api/agents/id/logs?limit=10&limit=20"),
      {
        params: Promise.resolve({ agentId: ACTIVE_AGENT_ID }),
      },
    );

    expect(repeatedAfterResponse.status).toBe(400);
    expect(await repeatedAfterResponse.json()).toEqual({
      error: {
        code: "validation_failed",
        message: "After must be a non-negative safe integer.",
      },
    });
    expect(repeatedLimitResponse.status).toBe(400);
    expect(await repeatedLimitResponse.json()).toEqual({
      error: {
        code: "validation_failed",
        message: "Limit must be a positive integer.",
      },
    });
    expect(mocks.createDatabaseConnection).not.toHaveBeenCalled();
  });

  it("returns not found for missing or soft-deleted agents before loading logs", async () => {
    mocks.createDatabaseConnection.mockReturnValue({ db: "db", close: mocks.close });
    mocks.getActiveAgentForDevelopmentUser.mockResolvedValue(null);
    const { GET } = await import("@/app/api/agents/[agentId]/logs/route");

    const response = await GET(new Request("http://localhost/api/agents/id/logs"), {
      params: Promise.resolve({ agentId: ACTIVE_AGENT_ID }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: {
        code: "agent_not_found",
        message: "Agent could not be found.",
      },
    });
    expect(mocks.listAgentLogs).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("returns safe JSON when persistence fails", async () => {
    mocks.createDatabaseConnection.mockReturnValue({ db: "db", close: mocks.close });
    mocks.getActiveAgentForDevelopmentUser.mockResolvedValue({
      id: ACTIVE_AGENT_ID,
    });
    mocks.listAgentLogs.mockRejectedValue(new Error("postgres://user:pass@localhost/db"));
    const { GET } = await import("@/app/api/agents/[agentId]/logs/route");

    const response = await GET(new Request("http://localhost/api/agents/id/logs"), {
      params: Promise.resolve({ agentId: ACTIVE_AGENT_ID }),
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "agent_logs_failed",
        message: "Agent logs could not be loaded.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});

function logDto(sequence: number) {
  return {
    id: `00000000-0000-4000-8000-00000000030${sequence}`,
    agentId: ACTIVE_AGENT_ID,
    runnerId: null,
    stream: "stdout",
    level: "info",
    message: `line ${sequence}`,
    sequence,
    createdAt: "2026-07-04T06:00:00.000Z",
  };
}
