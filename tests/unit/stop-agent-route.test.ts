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
    stopAgentForDevelopmentUser: vi.fn(),
  };
});

vi.mock("@/src/server/agents/lifecycle", () => ({
  AgentLifecyclePersistenceError: mocks.AgentLifecyclePersistenceError,
  stopAgentForDevelopmentUser: mocks.stopAgentForDevelopmentUser,
}));

describe("POST /api/agents/[agentId]/actions/stop route", () => {
  afterEach(() => {
    mocks.stopAgentForDevelopmentUser.mockReset();
  });

  it("returns validation JSON for malformed percent-encoded agent IDs", async () => {
    const { POST } = await import("@/app/api/agents/[agentId]/actions/stop/route");

    const response = await POST(new Request("http://localhost/api/agents/stop"), {
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
    expect(mocks.stopAgentForDevelopmentUser).not.toHaveBeenCalled();
  });

  it("returns a safe persistence error response", async () => {
    mocks.stopAgentForDevelopmentUser.mockRejectedValueOnce(
      new mocks.AgentLifecyclePersistenceError(),
    );
    const { POST } = await import("@/app/api/agents/[agentId]/actions/stop/route");

    const response = await POST(new Request("http://localhost/api/agents/stop"), {
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "agent_stop_failed",
        message: "Agent could not be stopped.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });
});
