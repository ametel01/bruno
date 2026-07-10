import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ACTIVE_AGENT_ID = "00000000-0000-4000-8000-000000000201";
const USER_ID = "00000000-0000-4000-8000-000000000101";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  createDatabaseConnection: vi.fn(),
  listAgentEventFeedForUser: vi.fn(),
  requireConfiguredApplicationUser: vi.fn(),
  transaction: vi.fn(async (run: (tx: string) => unknown) => await run("tx")),
}));

vi.mock("@/src/server/db/client", () => ({
  createDatabaseConnection: mocks.createDatabaseConnection,
}));

vi.mock("@/src/server/events/agent-events", () => ({
  listAgentEventFeedForUser: mocks.listAgentEventFeedForUser,
}));

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireConfiguredApplicationUser,
}));

describe("GET /api/agents/[agentId]/events route", () => {
  beforeEach(() => {
    mocks.requireConfiguredApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
    mocks.createDatabaseConnection.mockReturnValue({
      db: { transaction: mocks.transaction },
      close: mocks.close,
    });
  });

  afterEach(() => {
    mocks.close.mockReset();
    mocks.createDatabaseConnection.mockReset();
    mocks.listAgentEventFeedForUser.mockReset();
    mocks.requireConfiguredApplicationUser.mockReset();
    mocks.transaction.mockClear();
  });

  it("returns active-agent event DTO pages and passes bounded pagination to the feed helper", async () => {
    mocks.listAgentEventFeedForUser.mockResolvedValue({
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
    expect(mocks.listAgentEventFeedForUser).toHaveBeenCalledWith({
      db: "tx",
      userId: USER_ID,
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
    expect(mocks.listAgentEventFeedForUser).not.toHaveBeenCalled();
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
    mocks.listAgentEventFeedForUser.mockResolvedValue({
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
    mocks.listAgentEventFeedForUser.mockResolvedValue({
      ok: false,
      reason: "agent_not_found",
    });
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
    expect(mocks.listAgentEventFeedForUser).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("returns safe JSON when persistence fails", async () => {
    mocks.listAgentEventFeedForUser.mockRejectedValue(
      new Error("postgres://user:pass@localhost/db"),
    );
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
