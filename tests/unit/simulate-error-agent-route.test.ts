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
    simulateErrorAgentForUser: vi.fn(),
  };
});

vi.mock("@/src/server/agents/lifecycle", () => ({
  AgentLifecyclePersistenceError: mocks.AgentLifecyclePersistenceError,
  simulateErrorAgentForUser: mocks.simulateErrorAgentForUser,
}));

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireConfiguredApplicationUser,
}));

describe("POST /api/agents/[agentId]/actions/simulate-error route", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    mocks.requireConfiguredApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
  });

  afterEach(() => {
    mocks.requireConfiguredApplicationUser.mockReset();
    mocks.simulateErrorAgentForUser.mockReset();
    setNodeEnv(originalNodeEnv);
  });

  it("returns validation JSON for malformed percent-encoded agent IDs", async () => {
    setNodeEnv("test");
    const { POST } = await import("@/app/api/agents/[agentId]/actions/simulate-error/route");

    const response = await POST(new Request("http://localhost/api/agents/simulate-error"), {
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
    expect(mocks.simulateErrorAgentForUser).not.toHaveBeenCalled();
  });

  it("rejects production requests before calling the lifecycle helper", async () => {
    setNodeEnv("production");
    const { POST } = await import("@/app/api/agents/[agentId]/actions/simulate-error/route");

    const response = await POST(new Request("http://localhost/api/agents/simulate-error"), {
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      error: {
        code: "development_only_action",
        message: "Simulated error actions are unavailable in production.",
      },
    });
    expect(mocks.simulateErrorAgentForUser).not.toHaveBeenCalled();
  });

  it("returns a safe persistence error response", async () => {
    setNodeEnv("test");
    mocks.simulateErrorAgentForUser.mockRejectedValueOnce(
      new mocks.AgentLifecyclePersistenceError(),
    );
    const { POST } = await import("@/app/api/agents/[agentId]/actions/simulate-error/route");

    const response = await POST(new Request("http://localhost/api/agents/simulate-error"), {
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "agent_simulate_error_failed",
        message: "Agent error could not be simulated.",
      },
    });
    expect(mocks.simulateErrorAgentForUser).toHaveBeenCalledWith(
      USER_ID,
      "3e47bed7-b58f-4394-93c0-01e3d1e51774",
    );
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });
});

function setNodeEnv(value: string | undefined) {
  Object.defineProperty(process.env, "NODE_ENV", {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}
