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
    getAssignedRunnerForActiveAgentDevelopmentUser: vi.fn(),
    getLifecycleManualRunnerAdapter: vi.fn(),
    getLifecycleRunnerAdapter: vi.fn(),
    listAgentLogs: vi.fn(),
    manualStreamLogs: vi.fn(),
    streamLogs: vi.fn(),
  };
});

vi.mock("@/src/server/db/client", () => ({
  createDatabaseConnection: mocks.createDatabaseConnection,
}));

vi.mock("@/src/server/agents/list-agents", () => ({
  AgentDetailPersistenceError: mocks.AgentDetailPersistenceError,
  getActiveAgentForDevelopmentUser: mocks.getActiveAgentForDevelopmentUser,
}));

vi.mock("@/src/server/agents/lifecycle", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/src/server/agents/lifecycle")>();

  return {
    ...original,
    getLifecycleManualRunnerAdapter: mocks.getLifecycleManualRunnerAdapter,
    getLifecycleRunnerAdapter: mocks.getLifecycleRunnerAdapter,
  };
});

vi.mock("@/src/server/logs/agent-logs", () => ({
  listAgentLogs: mocks.listAgentLogs,
}));

vi.mock("@/src/server/runners/manual-runner-persistence", () => ({
  ACTIVE_RUNNER_STATUS: "active",
  getAssignedRunnerForActiveAgentDevelopmentUser:
    mocks.getAssignedRunnerForActiveAgentDevelopmentUser,
  MANUAL_RUNNER_KIND: "manual_vps",
}));

describe("GET /api/agents/[agentId]/logs route", () => {
  afterEach(() => {
    mocks.close.mockReset();
    mocks.createDatabaseConnection.mockReset();
    mocks.getActiveAgentForDevelopmentUser.mockReset();
    mocks.getAssignedRunnerForActiveAgentDevelopmentUser.mockReset();
    mocks.getLifecycleManualRunnerAdapter.mockReset();
    mocks.getLifecycleRunnerAdapter.mockReset();
    mocks.listAgentLogs.mockReset();
    mocks.manualStreamLogs.mockReset();
    mocks.streamLogs.mockReset();
  });

  it("streams running active-agent logs through the lifecycle runner with bounded pagination", async () => {
    mocks.createDatabaseConnection.mockReturnValue({ db: "db", close: mocks.close });
    mocks.getActiveAgentForDevelopmentUser.mockResolvedValue({
      id: ACTIVE_AGENT_ID,
      status: "running",
    });
    mocks.getAssignedRunnerForActiveAgentDevelopmentUser.mockResolvedValue(null);
    mocks.getLifecycleRunnerAdapter.mockReturnValue({
      streamLogs: mocks.streamLogs,
    });
    mocks.streamLogs.mockResolvedValue({
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
      logs: [publicLogDto(1), publicLogDto(2)],
      nextAfter: 2,
    });
    expect(mocks.getActiveAgentForDevelopmentUser).toHaveBeenCalledWith(ACTIVE_AGENT_ID, {
      createConnection: expect.any(Function),
    });
    expect(mocks.getLifecycleRunnerAdapter).toHaveBeenCalledOnce();
    expect(mocks.getLifecycleManualRunnerAdapter).not.toHaveBeenCalled();
    expect(mocks.streamLogs).toHaveBeenCalledWith({
      agentId: ACTIVE_AGENT_ID,
      after: 0,
      limit: 100,
    });
    expect(mocks.listAgentLogs).not.toHaveBeenCalled();
    expect(firstInvocationOrder(mocks.getActiveAgentForDevelopmentUser)).toBeLessThan(
      firstInvocationOrder(mocks.streamLogs),
    );
    expect(JSON.stringify(body)).not.toContain("agent_id");
    expect(JSON.stringify(body)).not.toContain("agentId");
    expect(JSON.stringify(body)).not.toContain(ACTIVE_AGENT_ID);
    expect(JSON.stringify(body)).not.toContain("00000000-0000-4000-8000-000000000301");
    expect(JSON.stringify(body)).not.toContain("00000000-0000-4000-8000-000000000302");
    expect(JSON.stringify(body)).not.toContain("runnerId");
    expect(JSON.stringify(body)).not.toContain("localRunnerProcessId");
    expect(JSON.stringify(body)).not.toContain("dockerRunnerContainerId");
    expect(JSON.stringify(body)).not.toContain("metadata");
    expect(JSON.stringify(body)).not.toContain("00000000-0000-4000-8000-00000000090");
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("pulls running assigned manual runner logs and returns the same safe public DTO", async () => {
    mocks.createDatabaseConnection.mockReturnValue({ db: "db", close: mocks.close });
    mocks.getActiveAgentForDevelopmentUser.mockResolvedValue({
      id: ACTIVE_AGENT_ID,
      status: "running",
    });
    mocks.getAssignedRunnerForActiveAgentDevelopmentUser.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000777",
      kind: "manual_vps",
      endpointUrl: "https://runner.example.com",
    });
    mocks.getLifecycleManualRunnerAdapter.mockReturnValue({
      streamLogs: mocks.manualStreamLogs,
    });
    mocks.manualStreamLogs.mockResolvedValue({
      logs: [
        logDto(1, {
          stream: "stdout",
          message: "manual runner ready",
          source: "manual_runner",
        }),
        logDto(2, {
          stream: "stderr",
          level: "error",
          message: "TOKEN=runner-secret",
          source: "manual_runner",
        }),
      ],
      nextAfter: 2,
    });
    const { GET } = await import("@/app/api/agents/[agentId]/logs/route");

    const response = await GET(new Request("http://localhost/api/agents/id/logs?limit=2"), {
      params: Promise.resolve({ agentId: ACTIVE_AGENT_ID }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      logs: [
        publicLogDto(1, {
          source: "manual_runner",
          stream: "stdout",
          message: "manual runner ready",
        }),
        publicLogDto(2, {
          source: "manual_runner",
          stream: "stderr",
          level: "error",
          message: "Sensitive details omitted.",
        }),
      ],
      nextAfter: 2,
    });
    expect(mocks.getAssignedRunnerForActiveAgentDevelopmentUser).toHaveBeenCalledWith(
      ACTIVE_AGENT_ID,
      { createConnection: expect.any(Function) },
    );
    expect(mocks.getLifecycleManualRunnerAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ endpointUrl: "https://runner.example.com" }),
      { createConnection: expect.any(Function) },
    );
    expect(mocks.getLifecycleRunnerAdapter).not.toHaveBeenCalled();
    expect(mocks.manualStreamLogs).toHaveBeenCalledWith({
      agentId: ACTIVE_AGENT_ID,
      limit: 2,
    });
    expect(JSON.stringify(body)).not.toContain("runnerId");
    expect(JSON.stringify(body)).not.toContain("00000000-0000-4000-8000-000000000777");
    expect(JSON.stringify(body)).not.toContain("runner-secret");
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("returns safe public stdout and stderr log fields in helper order", async () => {
    mocks.createDatabaseConnection.mockReturnValue({ db: "db", close: mocks.close });
    mocks.getActiveAgentForDevelopmentUser.mockResolvedValue({
      id: ACTIVE_AGENT_ID,
      status: "stopped",
    });
    mocks.listAgentLogs.mockResolvedValue({
      logs: [
        logDto(1, { stream: "stdout", message: "runner stdout line" }),
        logDto(2, {
          stream: "stderr",
          level: "error",
          message: "TOKEN=stored-for-downstream failed",
        }),
        logDto(3, {
          stream: "stderr",
          level: "error",
          message:
            "Error: failed\n    at run (/app/worker.ts:10:2)\npostgres://user:pass@localhost/db",
        }),
      ],
      nextAfter: 3,
    });
    const { GET } = await import("@/app/api/agents/[agentId]/logs/route");

    const response = await GET(new Request("http://localhost/api/agents/id/logs"), {
      params: Promise.resolve({ agentId: ACTIVE_AGENT_ID }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      logs: [
        publicLogDto(1, { stream: "stdout", message: "runner stdout line" }),
        publicLogDto(2, {
          stream: "stderr",
          level: "error",
          message: "Sensitive details omitted.",
        }),
        publicLogDto(3, {
          stream: "stderr",
          level: "error",
          message: "Error: failed [redacted database URL]",
        }),
      ],
      nextAfter: 3,
    });
    expect(JSON.stringify(body)).not.toContain("agentId");
    expect(JSON.stringify(body)).not.toContain(ACTIVE_AGENT_ID);
    expect(JSON.stringify(body)).not.toContain("00000000-0000-4000-8000-000000000301");
    expect(JSON.stringify(body)).not.toContain("00000000-0000-4000-8000-000000000302");
    expect(JSON.stringify(body)).not.toContain("00000000-0000-4000-8000-000000000303");
    expect(JSON.stringify(body)).not.toContain("runnerId");
    expect(JSON.stringify(body)).not.toContain("localRunnerProcessId");
    expect(JSON.stringify(body)).not.toContain("dockerRunnerContainerId");
    expect(JSON.stringify(body)).not.toContain("metadata");
    expect(JSON.stringify(body)).not.toContain("00000000-0000-4000-8000-000000000901");
    expect(JSON.stringify(body)).not.toContain("00000000-0000-4000-8000-000000000902");
    expect(JSON.stringify(body)).not.toContain("raw-token-metadata");
    expect(JSON.stringify(body)).not.toContain("stored-for-downstream");
    expect(JSON.stringify(body)).not.toContain("postgres://");
    expect(JSON.stringify(body)).not.toContain("/app/worker.ts");
    expect(mocks.getLifecycleRunnerAdapter).not.toHaveBeenCalled();
    expect(mocks.getAssignedRunnerForActiveAgentDevelopmentUser).not.toHaveBeenCalled();
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
    expect(mocks.getLifecycleRunnerAdapter).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("returns safe JSON when lifecycle runner log streaming fails before listing logs", async () => {
    mocks.createDatabaseConnection.mockReturnValue({ db: "db", close: mocks.close });
    mocks.getActiveAgentForDevelopmentUser.mockResolvedValue({
      id: ACTIVE_AGENT_ID,
      status: "running",
    });
    mocks.getAssignedRunnerForActiveAgentDevelopmentUser.mockResolvedValue(null);
    mocks.getLifecycleRunnerAdapter.mockReturnValue({
      streamLogs: mocks.streamLogs,
    });
    mocks.streamLogs.mockRejectedValue(new Error("postgres://user:pass@localhost/db"));
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
    expect(mocks.listAgentLogs).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("returns safe JSON when persistence fails", async () => {
    mocks.createDatabaseConnection.mockReturnValue({ db: "db", close: mocks.close });
    mocks.getActiveAgentForDevelopmentUser.mockResolvedValue({
      id: ACTIVE_AGENT_ID,
      status: "stopped",
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

function logDto(
  sequence: number,
  overrides: Partial<{
    stream: string;
    level: string;
    message: string;
    source: string;
  }> = {},
) {
  return {
    id: `00000000-0000-4000-8000-00000000030${sequence}`,
    agentId: ACTIVE_AGENT_ID,
    runnerId: "00000000-0000-4000-8000-000000000901",
    localRunnerProcessId: "00000000-0000-4000-8000-000000000901",
    dockerRunnerContainerId: "00000000-0000-4000-8000-000000000902",
    source: overrides.source ?? "docker",
    stream: overrides.stream ?? "stdout",
    level: overrides.level ?? "info",
    message: overrides.message ?? `line ${sequence}`,
    metadata: {
      token: "raw-token-metadata",
    },
    sequence,
    createdAt: "2026-07-04T06:00:00.000Z",
  };
}

function publicLogDto(
  sequence: number,
  overrides: Partial<{
    source: string;
    stream: string;
    level: string;
    message: string;
  }> = {},
) {
  return {
    source: overrides.source ?? "docker",
    stream: overrides.stream ?? "stdout",
    level: overrides.level ?? "info",
    message: overrides.message ?? `line ${sequence}`,
    sequence,
    createdAt: "2026-07-04T06:00:00.000Z",
  };
}

function firstInvocationOrder(mock: { mock: { invocationCallOrder: number[] } }): number {
  const [order] = mock.mock.invocationCallOrder;

  if (order === undefined) {
    throw new Error("Expected mock to have been called.");
  }

  return order;
}
