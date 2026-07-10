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
    deleteAgentForUser: vi.fn(),
    requireConfiguredApplicationUser: vi.fn(),
  };
});

vi.mock("@/src/server/agents/lifecycle", () => ({
  AgentLifecyclePersistenceError: mocks.AgentLifecyclePersistenceError,
  deleteAgentForUser: mocks.deleteAgentForUser,
}));

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireConfiguredApplicationUser,
}));

describe("DELETE /api/agents/[agentId] route", () => {
  beforeEach(() => {
    mocks.requireConfiguredApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
  });

  afterEach(() => {
    mocks.deleteAgentForUser.mockReset();
    mocks.requireConfiguredApplicationUser.mockReset();
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
    expect(mocks.deleteAgentForUser).not.toHaveBeenCalled();
  });

  it("returns a safe persistence error response", async () => {
    mocks.deleteAgentForUser.mockRejectedValueOnce(new mocks.AgentLifecyclePersistenceError());
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
    expect(mocks.deleteAgentForUser).toHaveBeenCalledWith(
      USER_ID,
      "3e47bed7-b58f-4394-93c0-01e3d1e51774",
    );
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });
});
