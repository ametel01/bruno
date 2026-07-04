import { afterEach, describe, expect, it, vi } from "vitest";

const ACTIVE_AGENT_ID = "00000000-0000-4000-8000-000000000201";
const USER_ID = "00000000-0000-4000-8000-000000000101";

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
    listAgentEventFeed: vi.fn(),
  };
});

vi.mock("@/src/server/db/client", () => ({
  createDatabaseConnection: mocks.createDatabaseConnection,
}));

vi.mock("@/src/server/agents/list-agents", () => ({
  AgentDetailPersistenceError: mocks.AgentDetailPersistenceError,
  getActiveAgentForDevelopmentUser: mocks.getActiveAgentForDevelopmentUser,
}));

vi.mock("@/src/server/events/agent-events", () => ({
  listAgentEventFeed: mocks.listAgentEventFeed,
}));

describe("GET /api/agents/[agentId]/events route", () => {
  afterEach(() => {
    mocks.close.mockReset();
    mocks.createDatabaseConnection.mockReset();
    mocks.getActiveAgentForDevelopmentUser.mockReset();
    mocks.listAgentEventFeed.mockReset();
  });

  it("returns active-agent event DTO pages and passes bounded pagination to the feed helper", async () => {
    mocks.createDatabaseConnection.mockReturnValue({ db: "db", close: mocks.close });
    mocks.getActiveAgentForDevelopmentUser.mockResolvedValue({
      id: ACTIVE_AGENT_ID,
    });
    mocks.listAgentEventFeed.mockResolvedValue({
      ok: true,
      page: {
        events: [
          eventDto("00000000-0000-4000-8000-000000000303"),
          eventDto("00000000-0000-4000-8000-000000000302"),
        ],
        nextCursor: "opaque-cursor",
      },
    });
    const { GET } = await import("@/app/api/agents/[agentId]/events/route");

    const response = await GET(
      new Request("http://localhost/api/agents/id/events?limit=500&cursor=current-cursor"),
      {
        params: Promise.resolve({ agentId: ACTIVE_AGENT_ID }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      events: [
        eventDto("00000000-0000-4000-8000-000000000303"),
        eventDto("00000000-0000-4000-8000-000000000302"),
      ],
      nextCursor: "opaque-cursor",
    });
    expect(mocks.getActiveAgentForDevelopmentUser).toHaveBeenCalledWith(ACTIVE_AGENT_ID, {
      createConnection: expect.any(Function),
    });
    expect(mocks.listAgentEventFeed).toHaveBeenCalledWith({
      db: "db",
      agentId: ACTIVE_AGENT_ID,
      cursor: "current-cursor",
      limit: 100,
    });
    expect(JSON.stringify(body)).not.toContain("actorUserId");
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "missing", agentId: undefined },
    { name: "malformed", agentId: "not-a-uuid" },
    { name: "malformed percent-encoded", agentId: "%E0%A4%A" },
  ])("returns validation JSON for $name agent IDs", async ({ agentId }) => {
    const { GET } = await import("@/app/api/agents/[agentId]/events/route");

    const response = await GET(new Request("http://localhost/api/agents/id/events"), {
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
    expect(mocks.listAgentEventFeed).not.toHaveBeenCalled();
  });

  it.each([
    "0",
    "-1",
    "1.5",
    "many",
  ])("returns validation JSON for invalid limit %s", async (limit) => {
    const { GET } = await import("@/app/api/agents/[agentId]/events/route");

    const response = await GET(
      new Request(`http://localhost/api/agents/id/events?limit=${limit}`),
      {
        params: Promise.resolve({ agentId: ACTIVE_AGENT_ID }),
      },
    );
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

  it("returns validation JSON for malformed cursors", async () => {
    mocks.createDatabaseConnection.mockReturnValue({ db: "db", close: mocks.close });
    mocks.getActiveAgentForDevelopmentUser.mockResolvedValue({
      id: ACTIVE_AGENT_ID,
    });
    mocks.listAgentEventFeed.mockResolvedValue({
      ok: false,
      error: new Error("Malformed event feed cursor."),
    });
    const { GET } = await import("@/app/api/agents/[agentId]/events/route");

    const response = await GET(
      new Request("http://localhost/api/agents/id/events?cursor=not-a-cursor"),
      {
        params: Promise.resolve({ agentId: ACTIVE_AGENT_ID }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "validation_failed",
        message: "Cursor must be a valid event feed cursor.",
      },
    });
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("returns not found for missing or soft-deleted agents before loading events", async () => {
    mocks.createDatabaseConnection.mockReturnValue({ db: "db", close: mocks.close });
    mocks.getActiveAgentForDevelopmentUser.mockResolvedValue(null);
    const { GET } = await import("@/app/api/agents/[agentId]/events/route");

    const response = await GET(new Request("http://localhost/api/agents/id/events"), {
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
    expect(mocks.listAgentEventFeed).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("returns safe JSON when persistence fails", async () => {
    mocks.createDatabaseConnection.mockReturnValue({ db: "db", close: mocks.close });
    mocks.getActiveAgentForDevelopmentUser.mockResolvedValue({
      id: ACTIVE_AGENT_ID,
    });
    mocks.listAgentEventFeed.mockRejectedValue(new Error("postgres://user:pass@localhost/db"));
    const { GET } = await import("@/app/api/agents/[agentId]/events/route");

    const response = await GET(new Request("http://localhost/api/agents/id/events"), {
      params: Promise.resolve({ agentId: ACTIVE_AGENT_ID }),
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "agent_events_failed",
        message: "Agent events could not be loaded.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});

function eventDto(id: string) {
  return {
    id,
    agentId: ACTIVE_AGENT_ID,
    actor: {
      userId: USER_ID,
      displayName: "Local development user",
    },
    type: "agent.start_completed",
    message: 'Start completed for agent "Feed Agent".',
    metadata: {
      fromStatus: "starting",
      toStatus: "running",
    },
    metadataSummary: "starting -> running",
    createdAt: "2026-07-04T06:00:00.000Z",
  };
}
