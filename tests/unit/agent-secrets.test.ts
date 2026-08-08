import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createAgentForDevelopmentUser } from "@/src/server/agents/create-agent";
import {
  AgentSecretDecryptionError,
  AgentSecretTelegramConflictError,
  AgentSecretKeyringError,
  backfillTelegramSecretUniquenessMetadata,
  decryptAgentSecretValueForTest,
  fingerprintTelegramBotTokenForUniqueness,
  generateApiServerKeyForUser,
  listAgentSecretStatusesForUser,
  parseAgentSecretKeyring,
  prepareAgentSecretRow,
  replaceAgentSecretForUser,
  revokeAgentSecretForUser,
} from "@/src/server/agents/agent-secrets";
import { deleteAgentForDevelopmentUser } from "@/src/server/agents/lifecycle";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentSecrets } from "@/src/server/db/schema";

const KEYRING_ENV = {
  BRUNO_AGENT_SECRET_ACTIVE_KEY_VERSION: "v1",
  BRUNO_AGENT_SECRET_KEYS_JSON: JSON.stringify({
    v1: Buffer.alloc(32, 17).toString("base64url"),
    old: Buffer.alloc(32, 19).toString("base64url"),
  }),
};

describe("agent secret storage", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetSecretTables(connection);
  });

  afterEach(async () => {
    await resetSecretTables(connection);
    await connection.close();
  });

  it("encrypts, fingerprints, rotates, lists, and revokes owner-scoped agent secrets", async () => {
    const created = await createAgentForDevelopmentUser(
      { name: "Secret Agent", templateKey: "research_agent" },
      { createConnection: () => connection },
    );

    const stored = await replaceAgentSecretForUser(
      created.agent.userId,
      created.agent.id,
      {
        kind: "openrouter_api_key",
        value: "sk-or-v1-1234567890abcdefghijklmnopqrstuvwxyz",
      },
      {
        createConnection: () => connection,
        env: KEYRING_ENV,
        now: () => new Date("2026-07-08T01:00:00.000Z"),
        randomBytes: (size) => Buffer.alloc(size, 3),
      },
    );

    expect(stored).toMatchObject({
      ok: true,
      secret: {
        kind: "openrouter_api_key",
        configured: true,
        status: "active",
        fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
        rotatedAt: null,
      },
    });

    const [row] = await connection.db.select().from(agentSecrets);

    expect(row).toMatchObject({
      agentId: created.agent.id,
      kind: "openrouter_api_key",
      status: "active",
      keyVersion: "v1",
    });
    if (!row) {
      throw new Error("Expected active OpenRouter secret row.");
    }

    expect(JSON.stringify(row)).not.toContain("sk-or-v1");
    expect(row.ciphertext).not.toBe("sk-or-v1-1234567890abcdefghijklmnopqrstuvwxyz");
    expect(decryptAgentSecretValueForTest(row, parseAgentSecretKeyring(KEYRING_ENV))).toBe(
      "sk-or-v1-1234567890abcdefghijklmnopqrstuvwxyz",
    );

    const rotated = await replaceAgentSecretForUser(
      created.agent.userId,
      created.agent.id,
      {
        kind: "openrouter_api_key",
        value: "sk-or-v1-abcdefghijklmnopqrstuvwxyz1234567890",
      },
      {
        createConnection: () => connection,
        env: KEYRING_ENV,
        now: () => new Date("2026-07-08T02:00:00.000Z"),
        randomBytes: (size) => Buffer.alloc(size, 4),
      },
    );
    const rows = await connection.db
      .select()
      .from(agentSecrets)
      .where(eq(agentSecrets.agentId, created.agent.id));
    const activeRows = rows.filter((secret) => secret.status === "active");
    const revokedRows = rows.filter((secret) => secret.status === "revoked");

    expect(rotated).toMatchObject({
      ok: true,
      secret: {
        configured: true,
        rotatedAt: "2026-07-08T02:00:00.000Z",
      },
    });
    expect(activeRows).toHaveLength(1);
    expect(revokedRows).toHaveLength(1);
    expect(revokedRows[0]).toMatchObject({
      revokedAt: new Date("2026-07-08T02:00:00.000Z"),
    });

    const listed = await listAgentSecretStatusesForUser(created.agent.userId, created.agent.id, {
      createConnection: () => connection,
    });

    expect(listed).toMatchObject({
      ok: true,
      secrets: expect.arrayContaining([
        expect.objectContaining({
          kind: "openrouter_api_key",
          configured: true,
        }),
        expect.objectContaining({
          kind: "telegram_bot_token",
          configured: false,
        }),
      ]),
    });

    const revoked = await revokeAgentSecretForUser(
      created.agent.userId,
      created.agent.id,
      { kind: "openrouter_api_key" },
      {
        createConnection: () => connection,
        now: () => new Date("2026-07-08T03:00:00.000Z"),
      },
    );

    expect(revoked).toEqual({
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
    const allRows = await connection.db.select().from(agentSecrets);

    expect(allRows.every((secret) => secret.status === "revoked")).toBe(true);
  });

  it("validates keyrings, secret shapes, and decrypt failures without echoing secret values", async () => {
    const created = await createAgentForDevelopmentUser(
      { name: "Validation Agent", templateKey: "research_agent" },
      { createConnection: () => connection },
    );

    expect(() =>
      parseAgentSecretKeyring({
        BRUNO_AGENT_SECRET_ACTIVE_KEY_VERSION: "missing",
        BRUNO_AGENT_SECRET_KEYS_JSON: JSON.stringify({
          v1: Buffer.alloc(32).toString("base64"),
        }),
      }),
    ).toThrow(AgentSecretKeyringError);

    await expect(
      replaceAgentSecretForUser(
        created.agent.userId,
        created.agent.id,
        { kind: "openrouter_api_key", value: "sk-invalid-secret" },
        { createConnection: () => connection, env: KEYRING_ENV },
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "validation_failed",
      issues: [{ field: "value", message: "OpenRouter API key format is invalid." }],
    });

    await expect(
      replaceAgentSecretForUser(
        created.agent.userId,
        created.agent.id,
        { kind: "openai_api_key", value: `sk-${"a".repeat(32)}` },
        { createConnection: () => connection, env: KEYRING_ENV },
      ),
    ).resolves.toMatchObject({ ok: true, secret: { kind: "openai_api_key" } });
    await expect(
      replaceAgentSecretForUser(
        created.agent.userId,
        created.agent.id,
        { kind: "anthropic_api_key", value: `sk-ant-${"b".repeat(32)}` },
        { createConnection: () => connection, env: KEYRING_ENV },
      ),
    ).resolves.toMatchObject({ ok: true, secret: { kind: "anthropic_api_key" } });
    await expect(
      replaceAgentSecretForUser(
        created.agent.userId,
        created.agent.id,
        { kind: "openai_api_key", value: `sk-ant-${"c".repeat(32)}` },
        { createConnection: () => connection, env: KEYRING_ENV },
      ),
    ).resolves.toMatchObject({ ok: false, reason: "validation_failed" });

    await expect(
      replaceAgentSecretForUser(
        created.agent.userId,
        created.agent.id,
        { kind: "telegram_allowed_users", value: "123,*" },
        { createConnection: () => connection, env: KEYRING_ENV },
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "validation_failed",
      issues: [
        {
          field: "value",
          message: "Telegram allowed users must contain only numeric Telegram user IDs.",
        },
      ],
    });

    const stored = await generateApiServerKeyForUser(created.agent.userId, created.agent.id, {
      createConnection: () => connection,
      env: KEYRING_ENV,
      randomBytes: (size) => Buffer.alloc(size, 5),
    });

    expect(stored).toMatchObject({
      ok: true,
      secret: {
        kind: "api_server_key",
        configured: true,
      },
    });

    const [row] = await connection.db
      .select()
      .from(agentSecrets)
      .where(eq(agentSecrets.kind, "api_server_key"));

    if (!row) {
      throw new Error("Expected generated API server key row.");
    }

    expect(() =>
      decryptAgentSecretValueForTest(row, {
        activeVersion: "v1",
        keys: new Map([["v1", Buffer.alloc(32, 9)]]),
      }),
    ).toThrow(AgentSecretDecryptionError);
  });

  it("revokes active secrets when an agent is soft deleted", async () => {
    const created = await createAgentForDevelopmentUser(
      { name: "Delete Secret Agent", templateKey: "research_agent" },
      { createConnection: () => connection },
    );

    await replaceAgentSecretForUser(
      created.agent.userId,
      created.agent.id,
      { kind: "telegram_bot_token", value: "123456:abcdefghijklmnopqrstuvwxyz" },
      { createConnection: () => connection, env: KEYRING_ENV },
    );

    const deleted = await deleteAgentForDevelopmentUser(created.agent.id, {
      createConnection: () => connection,
      dockerRunnerAdapter: { cleanup: async () => ({ ok: true, container: null }) },
      now: () => new Date("2026-07-08T04:00:00.000Z"),
    });
    const [row] = await connection.db.select().from(agentSecrets);

    expect(deleted).toMatchObject({ ok: true });
    expect(row).toMatchObject({
      status: "revoked",
      revokedAt: new Date("2026-07-08T04:00:00.000Z"),
    });
  });

  it("stores stable Telegram uniqueness metadata without exposing it in secret status", async () => {
    const created = await createAgentForDevelopmentUser(
      { name: "Telegram Agent", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const token = "123456:abcdefghijklmnopqrstuvwxyz";

    await replaceAgentSecretForUser(
      created.agent.userId,
      created.agent.id,
      { kind: "telegram_bot_token", value: token },
      {
        createConnection: () => connection,
        env: KEYRING_ENV,
        randomBytes: (size) => Buffer.alloc(size, 8),
        telegramBotValidator: async () => ({
          ok: true,
          bot: { botId: "123456", username: "Valid_bot" },
        }),
      },
    );

    const [row] = await connection.db.select().from(agentSecrets);
    const listed = await listAgentSecretStatusesForUser(created.agent.userId, created.agent.id, {
      createConnection: () => connection,
    });

    expect(row).toMatchObject({
      uniquenessFingerprint: fingerprintTelegramBotTokenForUniqueness(token),
      providerSubjectId: "123456",
      providerUsername: "Valid_bot",
    });
    expect(JSON.stringify(listed)).not.toContain("uniquenessFingerprint");
    expect(JSON.stringify(listed)).not.toContain("providerSubjectId");
    expect(JSON.stringify(listed)).not.toContain("Valid_bot");

    const second = await createAgentForDevelopmentUser(
      { name: "Second Telegram Agent", templateKey: "research_agent" },
      { createConnection: () => connection },
    );

    await expect(
      replaceAgentSecretForUser(
        second.agent.userId,
        second.agent.id,
        { kind: "telegram_bot_token", value: token },
        {
          createConnection: () => connection,
          env: KEYRING_ENV,
          randomBytes: (size) => Buffer.alloc(size, 9),
          telegramBotValidator: async () => ({
            ok: true,
            bot: { botId: "123456", username: "Valid_bot" },
          }),
        },
      ),
    ).rejects.toBeInstanceOf(AgentSecretTelegramConflictError);
  });

  it("keeps Telegram replacement invalid-token and operational failures mutation-free", async () => {
    const created = await createAgentForDevelopmentUser(
      { name: "Telegram Validation Agent", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const originalToken = "123456:abcdefghijklmnopqrstuvwxyz";

    await replaceAgentSecretForUser(
      created.agent.userId,
      created.agent.id,
      { kind: "telegram_bot_token", value: originalToken },
      {
        createConnection: () => connection,
        env: KEYRING_ENV,
        telegramBotValidator: async () => ({
          ok: true,
          bot: { botId: "123456", username: "Valid_bot" },
        }),
      },
    );
    const [before] = await connection.db.select().from(agentSecrets);

    await expect(
      replaceAgentSecretForUser(
        created.agent.userId,
        created.agent.id,
        { kind: "telegram_bot_token", value: "234567:abcdefghijklmnopqrstuvwxyz" },
        {
          createConnection: () => connection,
          env: KEYRING_ENV,
          telegramBotValidator: async () => ({ ok: false, reason: "invalid_bot_token" }),
        },
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "validation_failed",
      issues: [{ field: "value", message: "Telegram bot token format is invalid." }],
    });
    await expect(
      replaceAgentSecretForUser(
        created.agent.userId,
        created.agent.id,
        { kind: "telegram_bot_token", value: "234567:abcdefghijklmnopqrstuvwxyz" },
        {
          createConnection: () => connection,
          env: KEYRING_ENV,
          telegramBotValidator: async () => ({
            ok: false,
            reason: "telegram_validation_timeout",
          }),
        },
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "telegram_validation_unavailable",
    });

    const rows = await connection.db.select().from(agentSecrets);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: before?.id,
      status: "active",
      uniquenessFingerprint: fingerprintTelegramBotTokenForUniqueness(originalToken),
      providerSubjectId: "123456",
    });
  });

  it("rejects active Telegram subject races even when token fingerprints differ", async () => {
    const first = await createAgentForDevelopmentUser(
      { name: "Subject Race One", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const second = await createAgentForDevelopmentUser(
      { name: "Subject Race Two", templateKey: "research_agent" },
      { createConnection: () => connection },
    );

    await replaceAgentSecretForUser(
      first.agent.userId,
      first.agent.id,
      { kind: "telegram_bot_token", value: "123456:abcdefghijklmnopqrstuvwxyz" },
      {
        createConnection: () => connection,
        env: KEYRING_ENV,
        telegramBotValidator: async () => ({
          ok: true,
          bot: { botId: "123456", username: "Valid_bot" },
        }),
      },
    );

    await expect(
      replaceAgentSecretForUser(
        second.agent.userId,
        second.agent.id,
        { kind: "telegram_bot_token", value: "654321:abcdefghijklmnopqrstuvwxyz" },
        {
          createConnection: () => connection,
          env: KEYRING_ENV,
          telegramBotValidator: async () => ({
            ok: true,
            bot: { botId: "123456", username: "Valid_bot" },
          }),
        },
      ),
    ).rejects.toBeInstanceOf(AgentSecretTelegramConflictError);

    const activeRows = (await connection.db.select().from(agentSecrets)).filter(
      (row) => row.status === "active",
    );
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]).toMatchObject({ agentId: first.agent.id, providerSubjectId: "123456" });
  });

  it("backfills legacy active Telegram uniqueness metadata and fails closed on undecryptable rows", async () => {
    const created = await createAgentForDevelopmentUser(
      { name: "Legacy Telegram Agent", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const token = "123456:abcdefghijklmnopqrstuvwxyz";

    await replaceAgentSecretForUser(
      created.agent.userId,
      created.agent.id,
      { kind: "telegram_bot_token", value: token },
      {
        createConnection: () => connection,
        env: KEYRING_ENV,
        randomBytes: (size) => Buffer.alloc(size, 10),
        telegramBotValidator: async () => ({
          ok: true,
          bot: { botId: "123456", username: "Valid_bot" },
        }),
      },
    );
    await connection.db
      .update(agentSecrets)
      .set({
        uniquenessFingerprint: null,
        providerSubjectId: null,
        providerUsername: null,
      })
      .where(eq(agentSecrets.kind, "telegram_bot_token"));

    await expect(
      backfillTelegramSecretUniquenessMetadata({ connection, env: KEYRING_ENV }),
    ).resolves.toEqual({ scanned: 1, updated: 1 });

    const [backfilled] = await connection.db.select().from(agentSecrets);
    expect(backfilled).toMatchObject({
      uniquenessFingerprint: fingerprintTelegramBotTokenForUniqueness(token),
      providerSubjectId: "123456",
      providerUsername: null,
    });

    await connection.db
      .update(agentSecrets)
      .set({
        uniquenessFingerprint: null,
        providerSubjectId: null,
        keyVersion: "missing",
      })
      .where(eq(agentSecrets.kind, "telegram_bot_token"));

    await expect(
      backfillTelegramSecretUniquenessMetadata({ connection, env: KEYRING_ENV }),
    ).rejects.toBeInstanceOf(AgentSecretDecryptionError);
  });

  it("fails legacy backfill closed on duplicate active tokens without partial metadata mutation", async () => {
    const first = await createAgentForDevelopmentUser(
      { name: "Legacy Duplicate One", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const second = await createAgentForDevelopmentUser(
      { name: "Legacy Duplicate Two", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const token = "123456:abcdefghijklmnopqrstuvwxyz";

    await replaceAgentSecretForUser(
      first.agent.userId,
      first.agent.id,
      { kind: "telegram_bot_token", value: token },
      {
        createConnection: () => connection,
        env: KEYRING_ENV,
        telegramBotValidator: async () => ({
          ok: true,
          bot: { botId: "123456", username: "Valid_bot" },
        }),
      },
    );
    await replaceAgentSecretForUser(
      second.agent.userId,
      second.agent.id,
      { kind: "telegram_bot_token", value: "654321:abcdefghijklmnopqrstuvwxyz" },
      {
        createConnection: () => connection,
        env: KEYRING_ENV,
        telegramBotValidator: async () => ({
          ok: true,
          bot: { botId: "654321", username: "Other_bot" },
        }),
      },
    );

    const duplicatePrepared = prepareAgentSecretRow({
      agentId: second.agent.id,
      kind: "telegram_bot_token",
      value: token,
      keyring: parseAgentSecretKeyring(KEYRING_ENV),
      now: new Date("2026-07-08T05:00:00.000Z"),
      rotatedAt: null,
      telegramBot: { botId: "123456", username: null },
      randomBytes: (size) => Buffer.alloc(size, 12),
    });
    await connection.db
      .update(agentSecrets)
      .set({
        uniquenessFingerprint: null,
        providerSubjectId: null,
        providerUsername: null,
      })
      .where(eq(agentSecrets.kind, "telegram_bot_token"));
    await connection.db
      .update(agentSecrets)
      .set({
        ciphertext: duplicatePrepared.ciphertext,
        iv: duplicatePrepared.iv,
        authTag: duplicatePrepared.authTag,
        keyVersion: duplicatePrepared.keyVersion,
        fingerprint: duplicatePrepared.fingerprint,
      })
      .where(eq(agentSecrets.agentId, second.agent.id));

    await expect(
      backfillTelegramSecretUniquenessMetadata({ connection, env: KEYRING_ENV }),
    ).rejects.toBeInstanceOf(AgentSecretTelegramConflictError);

    const rows = await connection.db.select().from(agentSecrets);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.uniquenessFingerprint === null)).toBe(true);
    expect(rows.every((row) => row.providerSubjectId === null)).toBe(true);
  });

  it("backfills active Telegram rows across key versions while ignoring revoked and soft-deleted history", async () => {
    const activeV1 = await createAgentForDevelopmentUser(
      { name: "Legacy Active V1", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const activeOld = await createAgentForDevelopmentUser(
      { name: "Legacy Active Old", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const revoked = await createAgentForDevelopmentUser(
      { name: "Legacy Revoked", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const softDeleted = await createAgentForDevelopmentUser(
      { name: "Legacy Soft Deleted", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const oldEnv = {
      ...KEYRING_ENV,
      BRUNO_AGENT_SECRET_ACTIVE_KEY_VERSION: "old",
    };

    await replaceAgentSecretForUser(
      activeV1.agent.userId,
      activeV1.agent.id,
      { kind: "telegram_bot_token", value: "123456:abcdefghijklmnopqrstuvwxyz" },
      {
        createConnection: () => connection,
        env: KEYRING_ENV,
        telegramBotValidator: async () => ({
          ok: true,
          bot: { botId: "123456", username: "Valid_bot" },
        }),
      },
    );
    await replaceAgentSecretForUser(
      activeOld.agent.userId,
      activeOld.agent.id,
      { kind: "telegram_bot_token", value: "654321:abcdefghijklmnopqrstuvwxyz" },
      {
        createConnection: () => connection,
        env: oldEnv,
        telegramBotValidator: async () => ({
          ok: true,
          bot: { botId: "654321", username: "Other_bot" },
        }),
      },
    );
    await replaceAgentSecretForUser(
      revoked.agent.userId,
      revoked.agent.id,
      { kind: "telegram_bot_token", value: "777777:abcdefghijklmnopqrstuvwxyz" },
      {
        createConnection: () => connection,
        env: KEYRING_ENV,
        telegramBotValidator: async () => ({
          ok: true,
          bot: { botId: "777777", username: null },
        }),
      },
    );
    await revokeAgentSecretForUser(
      revoked.agent.userId,
      revoked.agent.id,
      { kind: "telegram_bot_token" },
      { createConnection: () => connection },
    );
    await replaceAgentSecretForUser(
      softDeleted.agent.userId,
      softDeleted.agent.id,
      { kind: "telegram_bot_token", value: "888888:abcdefghijklmnopqrstuvwxyz" },
      {
        createConnection: () => connection,
        env: KEYRING_ENV,
        telegramBotValidator: async () => ({
          ok: true,
          bot: { botId: "888888", username: null },
        }),
      },
    );
    await deleteAgentForDevelopmentUser(softDeleted.agent.id, {
      createConnection: () => connection,
      dockerRunnerAdapter: { cleanup: async () => ({ ok: true, container: null }) },
    });

    await connection.db
      .update(agentSecrets)
      .set({
        uniquenessFingerprint: null,
        providerSubjectId: null,
        providerUsername: null,
      })
      .where(eq(agentSecrets.kind, "telegram_bot_token"));

    await expect(
      backfillTelegramSecretUniquenessMetadata({ connection, env: KEYRING_ENV }),
    ).resolves.toEqual({ scanned: 2, updated: 2 });

    const rows = await connection.db.select().from(agentSecrets);
    const activeRows = rows.filter((row) => row.status === "active");
    const inactiveRows = rows.filter((row) => row.status === "revoked");

    expect(activeRows).toHaveLength(2);
    expect(activeRows.map((row) => row.keyVersion).sort()).toEqual(["old", "v1"]);
    expect(activeRows.every((row) => row.uniquenessFingerprint !== null)).toBe(true);
    expect(activeRows.map((row) => row.providerSubjectId).sort()).toEqual(["123456", "654321"]);
    expect(inactiveRows.length).toBeGreaterThanOrEqual(2);
    expect(inactiveRows.every((row) => row.uniquenessFingerprint === null)).toBe(true);
    expect(inactiveRows.every((row) => row.providerSubjectId === null)).toBe(true);
  });
});

async function resetSecretTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_secrets, backups, agent_approvals, agent_configs, agent_usage_periods, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runner_heartbeats, runners, app_metadata, users restart identity cascade`;
}
