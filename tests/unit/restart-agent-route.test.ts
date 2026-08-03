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
    restartAgentForUser: vi.fn(),
  };
});

vi.mock("@/src/server/agents/lifecycle", () => ({
  AgentLifecyclePersistenceError: mocks.AgentLifecyclePersistenceError,
  restartAgentForUser: mocks.restartAgentForUser,
}));

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireConfiguredApplicationUser,
}));

describe("POST /api/agents/[agentId]/actions/restart route", () => {
  beforeEach(() => {
    mocks.requireConfiguredApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
  });

  afterEach(() => {
    mocks.requireConfiguredApplicationUser.mockReset();
    mocks.restartAgentForUser.mockReset();
  });

  it("returns validation JSON for malformed percent-encoded agent IDs", async () => {
    const { POST } = await import("@/app/api/agents/[agentId]/actions/restart/route");

    const response = await POST(new Request("http://localhost/api/agents/restart"), {
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
    expect(mocks.restartAgentForUser).not.toHaveBeenCalled();
  });

  it("returns the accepted operation and snapshot in the authenticated 202 DTO", async () => {
    const accepted = {
      ok: true,
      state: "accepted",
      agent: { id: "3e47bed7-b58f-4394-93c0-01e3d1e51774", status: "restarting" },
      event: { type: "agent.restart_requested" },
      events: [{ type: "agent.restart_requested" }],
      operation: {
        id: "11111111-1111-4111-8111-111111111111",
        action: "restart",
        target: {
          image: "hermes@example",
          launchSpecVersion: "agentbay.hermes.launch.v3",
          configRevision: "cfg-route",
        },
        acceptedAt: "2026-08-03T05:00:00.000Z",
      },
      snapshot: { phase: "accepted", readinessReason: "launch_accepted" },
    };
    mocks.restartAgentForUser.mockResolvedValueOnce(accepted);
    const { POST } = await import("@/app/api/agents/[agentId]/actions/restart/route");

    const response = await POST(new Request("http://localhost/api/agents/restart"), {
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(accepted);
  });

  it("preserves truthful synchronous 200 compatibility for a ready manual restart", async () => {
    mocks.restartAgentForUser.mockResolvedValueOnce({
      ok: true,
      state: "ready",
      agent: { id: "3e47bed7-b58f-4394-93c0-01e3d1e51774", status: "running" },
      event: { type: "agent.restart_requested" },
      events: [{ type: "agent.restart_requested" }, { type: "agent.restart_completed" }],
    });
    const { POST } = await import("@/app/api/agents/[agentId]/actions/restart/route");

    const response = await POST(new Request("http://localhost/api/agents/restart"), {
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });

    expect(response.status).toBe(200);
  });

  it("returns a safe persistence error response", async () => {
    mocks.restartAgentForUser.mockRejectedValueOnce(new mocks.AgentLifecyclePersistenceError());
    const { POST } = await import("@/app/api/agents/[agentId]/actions/restart/route");

    const response = await POST(new Request("http://localhost/api/agents/restart"), {
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "agent_restart_failed",
        message: "Agent could not be restarted.",
      },
    });
    expect(mocks.restartAgentForUser).toHaveBeenCalledWith(
      USER_ID,
      "3e47bed7-b58f-4394-93c0-01e3d1e51774",
    );
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });

  it("returns a safe Hermes setup response when restart is blocked", async () => {
    mocks.restartAgentForUser.mockResolvedValueOnce({
      ok: false,
      reason: "hermes_setup_incomplete",
      message: "Configure OpenRouter API key before starting this Hermes agent.",
    });
    const { POST } = await import("@/app/api/agents/[agentId]/actions/restart/route");

    const response = await POST(new Request("http://localhost/api/agents/restart"), {
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: {
        code: "hermes_setup_incomplete",
        message: "Configure OpenRouter API key before starting this Hermes agent.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
    expect(JSON.stringify(body)).not.toContain("sk-or-v1");
  });
});
