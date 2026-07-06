import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AgentLifecyclePersistenceError extends Error {
    constructor() {
      super("Agent lifecycle update failed.");
      this.name = "AgentLifecyclePersistenceError";
    }
  }

  return {
    AgentLifecyclePersistenceError,
    startAgentForDevelopmentUser: vi.fn(),
  };
});

vi.mock("@/src/server/agents/lifecycle", () => ({
  AgentLifecyclePersistenceError: mocks.AgentLifecyclePersistenceError,
  startAgentForDevelopmentUser: mocks.startAgentForDevelopmentUser,
}));

describe("POST /api/agents/[agentId]/actions/start route", () => {
  afterEach(() => {
    mocks.startAgentForDevelopmentUser.mockReset();
  });

  it("returns validation JSON for malformed percent-encoded agent IDs", async () => {
    const { POST } = await import("@/app/api/agents/[agentId]/actions/start/route");

    const response = await POST(new Request("http://localhost/api/agents/start"), {
      params: Promise.resolve({ agentId: "%E0%A4%A" }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "validation_failed",
        message: "Agent ID must be a valid UUID.",
      },
    });
    expect(mocks.startAgentForDevelopmentUser).not.toHaveBeenCalled();
  });

  it("returns a safe persistence error response", async () => {
    mocks.startAgentForDevelopmentUser.mockRejectedValueOnce(
      new mocks.AgentLifecyclePersistenceError(),
    );
    const { POST } = await import("@/app/api/agents/[agentId]/actions/start/route");

    const response = await POST(new Request("http://localhost/api/agents/start"), {
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "agent_start_failed",
        message: "Agent could not be started.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });

  it("returns a safe runner-capacity response when start is blocked", async () => {
    mocks.startAgentForDevelopmentUser.mockResolvedValueOnce({
      ok: false,
      reason: "runner_capacity_reached",
    });
    const { POST } = await import("@/app/api/agents/[agentId]/actions/start/route");

    const response = await POST(new Request("http://localhost/api/agents/start"), {
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: {
        code: "runner_capacity_reached",
        message: "Runner capacity reached.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });

  it("returns a safe plan-limit response when start is blocked", async () => {
    mocks.startAgentForDevelopmentUser.mockResolvedValueOnce({
      ok: false,
      reason: "plan_limit_reached",
      currentAgents: 2,
      maxAgents: 2,
    });
    const { POST } = await import("@/app/api/agents/[agentId]/actions/start/route");

    const response = await POST(new Request("http://localhost/api/agents/start"), {
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
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
});
