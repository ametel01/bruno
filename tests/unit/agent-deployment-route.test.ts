import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ACTIVE_AGENT_ID = "00000000-0000-4000-8000-000000000201";
const USER_ID = "00000000-0000-4000-8000-000000000101";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  createDatabaseConnection: vi.fn(),
  getLatestAgentDeploymentForUser: vi.fn(),
  requireConfiguredApplicationUser: vi.fn(),
  transaction: vi.fn(async (run: (tx: string) => unknown) => await run("tx")),
}));

vi.mock("@/src/server/db/client", () => ({
  createDatabaseConnection: mocks.createDatabaseConnection,
}));

vi.mock("@/src/server/agents/agent-deployments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/agents/agent-deployments")>();

  return {
    AgentDeploymentPersistenceError: actual.AgentDeploymentPersistenceError,
    getLatestAgentDeploymentForUser: mocks.getLatestAgentDeploymentForUser,
  };
});

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireConfiguredApplicationUser,
}));

describe("GET /api/agents/[agentId]/deployment route", () => {
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
    mocks.getLatestAgentDeploymentForUser.mockReset();
    mocks.requireConfiguredApplicationUser.mockReset();
    mocks.transaction.mockClear();
  });

  it("returns the latest owned deployment DTO without internal orchestration fields", async () => {
    const deployment = {
      id: "00000000-0000-4000-8000-000000000301",
      agentId: ACTIVE_AGENT_ID,
      stage: "connecting_telegram",
      configRevision: "cfg-1",
      attemptCount: 2,
      error: { code: "telegram_not_connected", detail: "Adapter is not connected." },
      nextAttemptAt: "2026-08-03T05:01:00.000Z",
      startedAt: "2026-08-03T05:00:00.000Z",
      completedAt: null,
      failedAt: null,
      createdAt: "2026-08-03T04:59:00.000Z",
      updatedAt: "2026-08-03T05:00:30.000Z",
    };
    mocks.getLatestAgentDeploymentForUser.mockResolvedValue({ ok: true, deployment });
    const { GET } = await import("@/app/api/agents/[agentId]/deployment/route");

    const response = await GET(new Request("http://localhost/api/agents/id/deployment"), {
      params: Promise.resolve({ agentId: ACTIVE_AGENT_ID }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ deployment });
    expect(mocks.getLatestAgentDeploymentForUser).toHaveBeenCalledWith({
      db: "tx",
      userId: USER_ID,
      agentId: ACTIVE_AGENT_ID,
    });
    expect(JSON.stringify(body)).not.toMatch(
      /userId|idempotencyKey|leaseOwner|leaseExpiresAt|endpoint|secret/i,
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("returns deployment null for an owned historical agent with no operation", async () => {
    mocks.getLatestAgentDeploymentForUser.mockResolvedValue({ ok: true, deployment: null });
    const { GET } = await import("@/app/api/agents/[agentId]/deployment/route");

    const response = await GET(new Request("http://localhost/api/agents/id/deployment"), {
      params: Promise.resolve({ agentId: ACTIVE_AGENT_ID }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ deployment: null });
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "missing", agentId: undefined },
    { name: "malformed", agentId: "not-a-uuid" },
    { name: "malformed percent-encoded", agentId: "%E0%A4%A" },
  ])("returns validation JSON for $name agent IDs before database access", async ({ agentId }) => {
    const { GET } = await import("@/app/api/agents/[agentId]/deployment/route");

    const response = await GET(new Request("http://localhost/api/agents/id/deployment"), {
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
    expect(mocks.getLatestAgentDeploymentForUser).not.toHaveBeenCalled();
  });

  it("returns the identical not-found response for missing, soft-deleted, and foreign agents", async () => {
    mocks.getLatestAgentDeploymentForUser.mockResolvedValue({
      ok: false,
      reason: "agent_not_found",
    });
    const { GET } = await import("@/app/api/agents/[agentId]/deployment/route");

    const response = await GET(new Request("http://localhost/api/agents/id/deployment"), {
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
    expect(JSON.stringify(body)).not.toContain(ACTIVE_AGENT_ID);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it.each([
    {
      ok: false,
      status: 401,
      code: "authentication_required",
    },
    {
      ok: false,
      status: 503,
      code: "auth_not_configured",
    },
  ])("returns safe authentication failures", async (authResult) => {
    mocks.requireConfiguredApplicationUser.mockResolvedValue(authResult);
    const { GET } = await import("@/app/api/agents/[agentId]/deployment/route");

    const response = await GET(new Request("http://localhost/api/agents/id/deployment"), {
      params: Promise.resolve({ agentId: ACTIVE_AGENT_ID }),
    });
    const body = await response.json();

    expect(response.status).toBe(authResult.status);
    expect(body.error.code).toBe(authResult.code);
    expect(mocks.createDatabaseConnection).not.toHaveBeenCalled();
  });

  it("returns safe JSON when persistence fails", async () => {
    mocks.getLatestAgentDeploymentForUser.mockRejectedValue(
      new Error("postgres://user:pass@localhost/db"),
    );
    const { GET } = await import("@/app/api/agents/[agentId]/deployment/route");

    const response = await GET(new Request("http://localhost/api/agents/id/deployment"), {
      params: Promise.resolve({ agentId: ACTIVE_AGENT_ID }),
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "agent_deployment_failed",
        message: "Agent deployment could not be loaded.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
