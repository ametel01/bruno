import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000009101";
const AGENT_ID = "00000000-0000-4000-8000-000000009102";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  transaction: vi.fn(async (run: (tx: string) => unknown) => await run("tx")),
}));

vi.mock("@/src/server/agents/agent-runtime-read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/agents/agent-runtime-read")>();
  return {
    AgentRuntimeReadPersistenceError: actual.AgentRuntimeReadPersistenceError,
    getAgentRuntimePresentationForUser: mocks.read,
  };
});

describe("GET /api/agents/[agentId]/runtime", () => {
  beforeEach(() => {
    mocks.read.mockResolvedValue({
      ok: true,
      runtime: {
        kind: "healthy",
        action: "none",
        label: "Ready",
        message: "Hermes gateway is ready.",
      },
    });
  });

  afterEach(() => {
    mocks.read.mockReset();
    mocks.transaction.mockClear();
  });

  it("returns an exact safe owner-scoped read with no-store and no controller fields", async () => {
    const { GET } = await import("@/app/api/agents/[agentId]/runtime/route");
    const response = await GET(
      new Request(`http://localhost/api/agents/${AGENT_ID}/runtime`),
      { params: Promise.resolve({ agentId: AGENT_ID }) },
      dependencies(USER_ID),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(body).toEqual({
      runtime: {
        kind: "healthy",
        action: "none",
        label: "Ready",
        message: "Hermes gateway is ready.",
      },
    });
    expect(mocks.read).toHaveBeenCalledWith({ db: "tx", userId: USER_ID, agentId: AGENT_ID });
    expect(JSON.stringify(body)).not.toMatch(
      /errorCode|revision|generation|counter|lease|operation|restart|timestamp/i,
    );
  });

  it("conceals missing, deleted, and foreign agents behind the same 404", async () => {
    mocks.read.mockResolvedValue({ ok: false, reason: "agent_not_found" });
    const { GET } = await import("@/app/api/agents/[agentId]/runtime/route");

    const response = await GET(
      new Request(`http://localhost/api/agents/${AGENT_ID}/runtime`),
      { params: Promise.resolve({ agentId: AGENT_ID }) },
      dependencies(USER_ID),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "agent_not_found", message: "Agent could not be found." },
    });
  });

  it("rejects malformed IDs and authentication before any runtime read", async () => {
    const { GET } = await import("@/app/api/agents/[agentId]/runtime/route");
    const malformed = await GET(
      new Request("http://localhost/api/agents/nope/runtime"),
      { params: Promise.resolve({ agentId: "not-a-uuid" }) },
      dependencies(USER_ID),
    );
    const unauthenticated = await GET(
      new Request(`http://localhost/api/agents/${AGENT_ID}/runtime`),
      { params: Promise.resolve({ agentId: AGENT_ID }) },
      dependencies(null),
    );

    expect(malformed.status).toBe(400);
    expect(unauthenticated.status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("returns a fixed persistence failure without leaking the exception", async () => {
    mocks.read.mockRejectedValue(new Error("postgres://private:credential@internal/runtime"));
    const { GET } = await import("@/app/api/agents/[agentId]/runtime/route");
    const response = await GET(
      new Request(`http://localhost/api/agents/${AGENT_ID}/runtime`),
      { params: Promise.resolve({ agentId: AGENT_ID }) },
      dependencies(USER_ID),
    );
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(500);
    expect(serialized).toContain("agent_runtime_failed");
    expect(serialized).not.toContain("postgres://");
  });
});

function dependencies(userId: string | null) {
  return {
    createConnection: () => ({ db: { transaction: mocks.transaction }, close: vi.fn() }) as never,
    requireApplicationUser: vi.fn(async () =>
      userId
        ? { ok: true as const, userId }
        : { ok: false as const, status: 401 as const, code: "unauthenticated" as const },
    ),
  };
}
