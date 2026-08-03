import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000101";

const mocks = vi.hoisted(() => {
  class AgentLifecyclePersistenceError extends Error {
    constructor() {
      super("Agent lifecycle update failed.");
      this.name = "AgentLifecyclePersistenceError";
    }
  }

  return {
    AgentLifecyclePersistenceError,
    requireConfiguredApplicationUser: vi.fn(),
    startAgentForUser: vi.fn(),
  };
});

vi.mock("@/src/server/agents/lifecycle", () => ({
  AgentLifecyclePersistenceError: mocks.AgentLifecyclePersistenceError,
  startAgentForUser: mocks.startAgentForUser,
}));

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireConfiguredApplicationUser,
}));

describe("POST /api/agents/[agentId]/actions/start route", () => {
  beforeEach(() => {
    mocks.requireConfiguredApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
  });

  afterEach(() => {
    mocks.requireConfiguredApplicationUser.mockReset();
    mocks.startAgentForUser.mockReset();
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
    expect(mocks.startAgentForUser).not.toHaveBeenCalled();
  });

  it("returns the accepted operation and snapshot in the authenticated 202 DTO", async () => {
    const accepted = {
      ok: true,
      state: "accepted",
      agent: { id: "3e47bed7-b58f-4394-93c0-01e3d1e51774", status: "starting" },
      event: { type: "agent.start_requested" },
      events: [{ type: "agent.start_requested" }],
      operation: {
        id: "11111111-1111-4111-8111-111111111111",
        action: "start",
        target: {
          image: "hermes@example",
          launchSpecVersion: "agentbay.hermes.launch.v3",
          configRevision: "cfg-route",
        },
        acceptedAt: "2026-08-03T05:00:00.000Z",
      },
      snapshot: { phase: "accepted", readinessReason: "launch_accepted" },
    };
    mocks.startAgentForUser.mockResolvedValueOnce(accepted);
    const { POST } = await import("@/app/api/agents/[agentId]/actions/start/route");

    const response = await POST(new Request("http://localhost/api/agents/start"), {
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(accepted);
  });

  it("preserves truthful synchronous 200 compatibility for a ready manual start", async () => {
    mocks.startAgentForUser.mockResolvedValueOnce({
      ok: true,
      state: "ready",
      agent: { id: "3e47bed7-b58f-4394-93c0-01e3d1e51774", status: "running" },
      event: { type: "agent.start_requested" },
      events: [{ type: "agent.start_requested" }, { type: "agent.start_completed" }],
    });
    const { POST } = await import("@/app/api/agents/[agentId]/actions/start/route");

    const response = await POST(new Request("http://localhost/api/agents/start"), {
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });

    expect(response.status).toBe(200);
  });

  it("returns a safe persistence error response", async () => {
    mocks.startAgentForUser.mockRejectedValueOnce(new mocks.AgentLifecyclePersistenceError());
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
    expect(mocks.startAgentForUser).toHaveBeenCalledWith(
      USER_ID,
      "3e47bed7-b58f-4394-93c0-01e3d1e51774",
    );
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });

  it("returns a safe runner-capacity response when start is blocked", async () => {
    mocks.startAgentForUser.mockResolvedValueOnce({
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

  it("returns a safe no-online-runner response when production start is blocked", async () => {
    mocks.startAgentForUser.mockResolvedValueOnce({
      ok: false,
      reason: "no_online_runner",
    });
    const { POST } = await import("@/app/api/agents/[agentId]/actions/start/route");

    const response = await POST(new Request("http://localhost/api/agents/start"), {
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: {
        code: "no_online_runner",
        message: "No online runner is available yet.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });

  it("returns a safe Hermes setup response when start is blocked", async () => {
    mocks.startAgentForUser.mockResolvedValueOnce({
      ok: false,
      reason: "hermes_setup_incomplete",
      message: "Configure Telegram bot token before starting this Hermes agent.",
    });
    const { POST } = await import("@/app/api/agents/[agentId]/actions/start/route");

    const response = await POST(new Request("http://localhost/api/agents/start"), {
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: {
        code: "hermes_setup_incomplete",
        message: "Configure Telegram bot token before starting this Hermes agent.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
    expect(JSON.stringify(body)).not.toContain("sk-or-v1");
  });

  it("returns a safe plan-limit response when start is blocked", async () => {
    mocks.startAgentForUser.mockResolvedValueOnce({
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
