import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000101";
const AGENT_ID = "00000000-0000-4000-8000-000000000165";

const mocks = vi.hoisted(() => {
  class AgentSecretKeyringError extends Error {
    constructor() {
      super("Agent secret keyring is not configured safely.");
      this.name = "AgentSecretKeyringError";
    }
  }

  class AgentSecretPersistenceError extends Error {
    constructor() {
      super("Agent secret persistence failed.");
      this.name = "AgentSecretPersistenceError";
    }
  }

  class AgentSecretTelegramConflictError extends Error {
    constructor() {
      super("Telegram bot token is already assigned to an active agent.");
      this.name = "AgentSecretTelegramConflictError";
    }
  }

  return {
    AgentSecretKeyringError,
    AgentSecretPersistenceError,
    AgentSecretTelegramConflictError,
    generateApiServerKeyForUser: vi.fn(),
    listAgentSecretStatusesForUser: vi.fn(),
    replaceAgentSecretForUser: vi.fn(),
    requireConfiguredApplicationUser: vi.fn(),
    revokeAgentSecretForUser: vi.fn(),
  };
});

vi.mock("@/src/server/agents/agent-secrets", async () => {
  const actual = await vi.importActual<typeof import("@/src/server/agents/agent-secrets")>(
    "@/src/server/agents/agent-secrets",
  );

  return {
    ...actual,
    AgentSecretKeyringError: mocks.AgentSecretKeyringError,
    AgentSecretPersistenceError: mocks.AgentSecretPersistenceError,
    AgentSecretTelegramConflictError: mocks.AgentSecretTelegramConflictError,
    generateApiServerKeyForUser: mocks.generateApiServerKeyForUser,
    listAgentSecretStatusesForUser: mocks.listAgentSecretStatusesForUser,
    replaceAgentSecretForUser: mocks.replaceAgentSecretForUser,
    revokeAgentSecretForUser: mocks.revokeAgentSecretForUser,
  };
});

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireConfiguredApplicationUser,
}));

describe("/api/agents/[agentId]/secrets route", () => {
  beforeEach(() => {
    mocks.requireConfiguredApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
  });

  afterEach(() => {
    mocks.generateApiServerKeyForUser.mockReset();
    mocks.listAgentSecretStatusesForUser.mockReset();
    mocks.replaceAgentSecretForUser.mockReset();
    mocks.requireConfiguredApplicationUser.mockReset();
    mocks.revokeAgentSecretForUser.mockReset();
  });

  it("lists safe secret statuses for the authenticated owner", async () => {
    mocks.listAgentSecretStatusesForUser.mockResolvedValue({
      ok: true,
      secrets: [
        {
          kind: "openrouter_api_key",
          configured: true,
          fingerprint: "0123456789abcdef",
          status: "active",
          createdAt: "2026-07-08T01:00:00.000Z",
          updatedAt: "2026-07-08T01:00:00.000Z",
          rotatedAt: null,
          revokedAt: null,
        },
      ],
    });
    const { GET } = await import("@/app/api/agents/[agentId]/secrets/route");

    const response = await GET(new Request(`http://localhost/api/agents/${AGENT_ID}/secrets`), {
      params: Promise.resolve({ agentId: AGENT_ID }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      secrets: [
        {
          kind: "openrouter_api_key",
          configured: true,
          fingerprint: "0123456789abcdef",
          status: "active",
          createdAt: "2026-07-08T01:00:00.000Z",
          updatedAt: "2026-07-08T01:00:00.000Z",
          rotatedAt: null,
          revokedAt: null,
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("ciphertext");
    expect(JSON.stringify(body)).not.toContain("sk-or-v1");
    expect(mocks.listAgentSecretStatusesForUser).toHaveBeenCalledWith(USER_ID, AGENT_ID);
  });

  it("stores user-managed secrets and rejects client-supplied api server keys", async () => {
    mocks.replaceAgentSecretForUser.mockResolvedValue({
      ok: true,
      secret: {
        kind: "telegram_allowed_users",
        configured: true,
        fingerprint: "0123456789abcdef",
        status: "active",
        createdAt: "2026-07-08T01:00:00.000Z",
        updatedAt: "2026-07-08T01:00:00.000Z",
        rotatedAt: null,
        revokedAt: null,
      },
    });
    const { PUT } = await import("@/app/api/agents/[agentId]/secrets/route");

    const response = await PUT(
      new Request(`http://localhost/api/agents/${AGENT_ID}/secrets`, {
        method: "PUT",
        body: JSON.stringify({ kind: "telegram_allowed_users", value: "123,456" }),
      }),
      { params: Promise.resolve({ agentId: AGENT_ID }) },
    );
    const rejected = await PUT(
      new Request(`http://localhost/api/agents/${AGENT_ID}/secrets`, {
        method: "PUT",
        body: JSON.stringify({ kind: "api_server_key", value: "bruno_agent_client_supplied" }),
      }),
      { params: Promise.resolve({ agentId: AGENT_ID }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      secret: {
        kind: "telegram_allowed_users",
        configured: true,
      },
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: {
        code: "validation_failed",
      },
    });
    expect(mocks.replaceAgentSecretForUser).toHaveBeenCalledWith(USER_ID, AGENT_ID, {
      kind: "telegram_allowed_users",
      value: "123,456",
    });
  });

  it("generates api server keys on request without returning the generated value", async () => {
    mocks.generateApiServerKeyForUser.mockResolvedValue({
      ok: true,
      secret: {
        kind: "api_server_key",
        configured: true,
        fingerprint: "fedcba9876543210",
        status: "active",
        createdAt: "2026-07-08T01:00:00.000Z",
        updatedAt: "2026-07-08T01:00:00.000Z",
        rotatedAt: null,
        revokedAt: null,
      },
    });
    const { PUT } = await import("@/app/api/agents/[agentId]/secrets/route");

    const response = await PUT(
      new Request(`http://localhost/api/agents/${AGENT_ID}/secrets`, {
        method: "PUT",
        body: JSON.stringify({ kind: "api_server_key", generate: true }),
      }),
      { params: Promise.resolve({ agentId: AGENT_ID }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      secret: {
        kind: "api_server_key",
        configured: true,
        fingerprint: "fedcba9876543210",
      },
    });
    expect(JSON.stringify(body)).not.toContain("bruno_agent_");
    expect(mocks.generateApiServerKeyForUser).toHaveBeenCalledWith(USER_ID, AGENT_ID);
  });

  it("revokes a secret and maps configuration failures safely", async () => {
    mocks.revokeAgentSecretForUser.mockResolvedValue({
      ok: true,
      secret: {
        kind: "openrouter_api_key",
        configured: false,
        fingerprint: null,
        status: null,
        createdAt: null,
        updatedAt: null,
        rotatedAt: null,
        revokedAt: null,
      },
    });
    mocks.replaceAgentSecretForUser.mockRejectedValueOnce(new mocks.AgentSecretKeyringError());
    const { DELETE, PUT } = await import("@/app/api/agents/[agentId]/secrets/route");

    const revoked = await DELETE(
      new Request(`http://localhost/api/agents/${AGENT_ID}/secrets`, {
        method: "DELETE",
        body: JSON.stringify({ kind: "openrouter_api_key" }),
      }),
      { params: Promise.resolve({ agentId: AGENT_ID }) },
    );
    const failed = await PUT(
      new Request(`http://localhost/api/agents/${AGENT_ID}/secrets`, {
        method: "PUT",
        body: JSON.stringify({ kind: "openrouter_api_key", value: "sk-or-v1-secret" }),
      }),
      { params: Promise.resolve({ agentId: AGENT_ID }) },
    );

    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({
      ok: true,
      secret: {
        kind: "openrouter_api_key",
        configured: false,
      },
    });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      error: {
        code: "agent_secret_configuration_invalid",
        message: "Agent secret storage is not configured safely.",
      },
    });
    expect(mocks.revokeAgentSecretForUser).toHaveBeenCalledWith(USER_ID, AGENT_ID, {
      kind: "openrouter_api_key",
    });
  });

  it("maps Telegram replacement validation, operational failures, and active-bot conflicts safely", async () => {
    const { PUT } = await import("@/app/api/agents/[agentId]/secrets/route");
    const putTelegramToken = () =>
      new Request(`http://localhost/api/agents/${AGENT_ID}/secrets`, {
        method: "PUT",
        body: JSON.stringify({
          kind: "telegram_bot_token",
          value: "123456:abcdefghijklmnopqrstuvwxyz",
        }),
      });

    mocks.replaceAgentSecretForUser
      .mockResolvedValueOnce({
        ok: false,
        reason: "validation_failed",
        issues: [{ field: "value", message: "Telegram bot token format is invalid." }],
      })
      .mockResolvedValueOnce({
        ok: false,
        reason: "telegram_validation_unavailable",
      })
      .mockRejectedValueOnce(new mocks.AgentSecretTelegramConflictError());

    const invalid = await PUT(putTelegramToken(), {
      params: Promise.resolve({ agentId: AGENT_ID }),
    });
    const unavailable = await PUT(putTelegramToken(), {
      params: Promise.resolve({ agentId: AGENT_ID }),
    });
    const conflict = await PUT(putTelegramToken(), {
      params: Promise.resolve({ agentId: AGENT_ID }),
    });

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: {
        code: "validation_failed",
        message: "Request validation failed.",
        issues: [{ field: "value", message: "Telegram bot token format is invalid." }],
      },
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: {
        code: "telegram_validation_unavailable",
        message: "Telegram bot validation is temporarily unavailable.",
      },
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: {
        code: "telegram_bot_in_use",
        message: "Telegram bot is already assigned to an active agent.",
      },
    });
  });
});
