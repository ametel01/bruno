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
    deleteAgentForDevelopmentUser: vi.fn(),
  };
});

vi.mock("@/src/server/agents/lifecycle", () => ({
  AgentLifecyclePersistenceError: mocks.AgentLifecyclePersistenceError,
  deleteAgentForDevelopmentUser: mocks.deleteAgentForDevelopmentUser,
}));

describe("DELETE /api/agents/[agentId] route", () => {
  afterEach(() => {
    mocks.deleteAgentForDevelopmentUser.mockReset();
  });

  it("returns validation JSON for malformed percent-encoded agent IDs", async () => {
    const { DELETE } = await import("@/app/api/agents/[agentId]/route");

    const response = await DELETE(new Request("http://localhost/api/agents/delete"), {
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
    expect(mocks.deleteAgentForDevelopmentUser).not.toHaveBeenCalled();
  });

  it("returns a safe persistence error response", async () => {
    mocks.deleteAgentForDevelopmentUser.mockRejectedValueOnce(
      new mocks.AgentLifecyclePersistenceError(),
    );
    const { DELETE } = await import("@/app/api/agents/[agentId]/route");

    const response = await DELETE(new Request("http://localhost/api/agents/delete"), {
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "agent_delete_failed",
        message: "Agent could not be deleted.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });
});
