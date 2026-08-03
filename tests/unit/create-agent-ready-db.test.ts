import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSecretKeyringError } from "@/src/server/agents/agent-secrets";
import {
  AgentPersistenceError,
  AgentRunnerAssignmentError,
  TelegramBotInUseError,
  createAgentForUser,
} from "@/src/server/agents/create-agent";
import { getAgentTemplateSnapshot } from "@/src/server/agents/templates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentConfigs,
  agentDeployments,
  agentEvents,
  agentSecrets,
  agents,
  runnerHeartbeats,
  runners,
  users,
} from "@/src/server/db/schema";

const USER_A_ID = "00000000-0000-4000-8000-000000000401";
const USER_B_ID = "00000000-0000-4000-8000-000000000402";
const FOREIGN_RUNNER_ID = "00000000-0000-4000-8000-000000000403";
const NOW = new Date("2026-08-03T06:00:00.000Z");
const TOKEN = "123456:abcdefghijklmnopqrstuvwxyz";
const SECOND_TOKEN = "654321:abcdefghijklmnopqrstuvwxyz";
const OPENROUTER_KEY = "sk-or-v1-abcdefghijklmnopqrstuvwxyz123456";
const KEYRING_ENV = {
  AGENTBAY_READY_AGENT_CREATION_ENABLED: "true",
  AGENTBAY_AGENT_SECRET_ACTIVE_KEY_VERSION: "v1",
  AGENTBAY_AGENT_SECRET_KEYS_JSON: JSON.stringify({
    v1: Buffer.alloc(32, 41).toString("base64url"),
    old: Buffer.alloc(32, 42).toString("base64url"),
  }),
};

describe("ready agent creation persistence", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetReadyCreateTables(connection);
    await connection.db.insert(users).values([{ id: USER_A_ID }, { id: USER_B_ID }]);
  });

  afterEach(async () => {
    await resetReadyCreateTables(connection);
    await connection.close();
  });

  it("atomically creates a stopped desired-running agent, config, four secrets, deployment, and safe event", async () => {
    const result = await createAgentForUser(USER_A_ID, readyInput("ready-key-001"), {
      createConnection: () => connection,
      env: KEYRING_ENV,
      now: () => NOW,
      randomBytes: incrementalRandomBytes(),
      telegramBotValidator: telegramValidator(),
    });

    expect("deployment" in result ? result.deployment.stage : null).toBe("pending");
    expect(result).toMatchObject({
      agent: {
        userId: USER_A_ID,
        status: "stopped",
        desiredStatus: "running",
        model: { provider: "openrouter", id: "openai/gpt-4.1-mini" },
        telegramBot: { id: "123456", username: "Valid_bot" },
      },
    });
    expect(JSON.stringify(result)).not.toContain(OPENROUTER_KEY);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("agb_agent_");

    const [agent] = await connection.db.select().from(agents);
    const [config] = await connection.db.select().from(agentConfigs);
    const secrets = await connection.db.select().from(agentSecrets);
    const [deployment] = await connection.db.select().from(agentDeployments);
    const [event] = await connection.db.select().from(agentEvents);

    expect(agent).toMatchObject({
      userId: USER_A_ID,
      status: "stopped",
      desiredStatus: "running",
      runnerId: null,
    });
    expect(config).toMatchObject({
      modelProvider: "openrouter",
      modelName: "openai/gpt-4.1-mini",
      systemPrompt: getAgentTemplateSnapshot("research_agent").defaultSystemPrompt,
    });
    expect(secrets).toHaveLength(4);
    expect(secrets.map((secret) => secret.kind).sort()).toEqual([
      "api_server_key",
      "openrouter_api_key",
      "telegram_allowed_users",
      "telegram_bot_token",
    ]);
    expect(new Set(secrets.map((secret) => secret.iv)).size).toBe(4);
    expect(secrets.find((secret) => secret.kind === "telegram_bot_token")).toMatchObject({
      uniquenessFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      providerSubjectId: "123456",
      providerUsername: "Valid_bot",
    });
    expect(deployment).toMatchObject({
      userId: USER_A_ID,
      agentId: agent?.id,
      idempotencyKey: "ready-key-001",
      configRevision: `cfg-${NOW.getTime()}`,
      stage: "pending",
      attemptCount: 0,
    });
    expect(event).toMatchObject({
      actorUserId: USER_A_ID,
      type: "agent.created",
      metadata: {
        templateKey: "research_agent",
        templateVersion: "1.0.0",
        status: "stopped",
        desiredStatus: "running",
        launchMode: "ready",
        modelProvider: "openrouter",
        modelName: "openai/gpt-4.1-mini",
        runnerAssignment: "none",
        deploymentId: deployment?.id,
      },
    });
    expect(JSON.stringify(event?.metadata)).not.toContain("123456");
    expect(JSON.stringify(event?.metadata)).not.toContain("ready-key-001");
  });

  it("replays an existing ready deployment before flag and credential validation", async () => {
    const validator = telegramValidator();
    const created = await createAgentForUser(USER_A_ID, readyInput("ready-key-002"), {
      createConnection: () => connection,
      env: KEYRING_ENV,
      now: () => NOW,
      randomBytes: incrementalRandomBytes(),
      telegramBotValidator: validator,
    });
    const replay = await createAgentForUser(
      USER_A_ID,
      {
        name: "Changed Body",
        templateKey: "inbox_triage_agent",
        runnerId: null,
        launchMode: "ready",
        idempotencyKey: "ready-key-002",
      },
      {
        createConnection: () => connection,
        env: { ...KEYRING_ENV, AGENTBAY_READY_AGENT_CREATION_ENABLED: "false" },
        telegramBotValidator: vi.fn(),
      },
    );

    expect(replay).toEqual(created);
    expect(validator).toHaveBeenCalledTimes(1);
    await expect(countRows(connection, "agents")).resolves.toBe(1);
    await expect(countRows(connection, "agent_events")).resolves.toBe(1);
  });

  it("checks requested runner ownership before Telegram validation", async () => {
    await seedForeignOnlineRunner(connection);
    const validator = telegramValidator();

    await expect(
      createAgentForUser(USER_A_ID, readyInput("ready-key-003", { runnerId: FOREIGN_RUNNER_ID }), {
        createConnection: () => connection,
        env: KEYRING_ENV,
        now: () => NOW,
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: validator,
      }),
    ).rejects.toBeInstanceOf(AgentRunnerAssignmentError);

    expect(validator).not.toHaveBeenCalled();
    await expect(countRows(connection, "agents")).resolves.toBe(0);
  });

  it("parses the secret keyring before Telegram validation", async () => {
    const validator = telegramValidator();

    await expect(
      createAgentForUser(USER_A_ID, readyInput("ready-key-003b"), {
        createConnection: () => connection,
        env: {
          ...KEYRING_ENV,
          AGENTBAY_AGENT_SECRET_ACTIVE_KEY_VERSION: "missing",
        },
        now: () => NOW,
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: validator,
      }),
    ).rejects.toBeInstanceOf(AgentSecretKeyringError);

    expect(validator).not.toHaveBeenCalled();
    await expect(countRows(connection, "agents")).resolves.toBe(0);
  });

  it("rolls back all ready rows on active Telegram bot conflicts", async () => {
    await createAgentForUser(USER_A_ID, readyInput("ready-key-004"), {
      createConnection: () => connection,
      env: KEYRING_ENV,
      now: () => NOW,
      randomBytes: incrementalRandomBytes(),
      telegramBotValidator: telegramValidator(),
    });

    await expect(
      createAgentForUser(USER_A_ID, readyInput("ready-key-005"), {
        createConnection: () => connection,
        env: KEYRING_ENV,
        now: () => new Date(NOW.getTime() + 1_000),
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: telegramValidator(),
      }),
    ).rejects.toBeInstanceOf(TelegramBotInUseError);

    await expect(countRows(connection, "agents")).resolves.toBe(1);
    await expect(countRows(connection, "agent_configs")).resolves.toBe(1);
    await expect(countRows(connection, "agent_secrets")).resolves.toBe(4);
    await expect(countRows(connection, "agent_deployments")).resolves.toBe(1);
    await expect(countRows(connection, "agent_events")).resolves.toBe(1);
  });

  it("rolls back when an existing soft-deleted same-key deployment wins insertion", async () => {
    const seeded = await createAgentForUser(USER_A_ID, readyInput("ready-key-006"), {
      createConnection: () => connection,
      env: KEYRING_ENV,
      now: () => NOW,
      randomBytes: incrementalRandomBytes(),
      telegramBotValidator: telegramValidator(),
    });

    if (!("deployment" in seeded)) {
      throw new Error("Expected seeded ready agent.");
    }

    await connection.db
      .update(agents)
      .set({ deletedAt: new Date(NOW.getTime() + 1_000) })
      .where(eq(agents.id, seeded.agent.id));

    await expect(
      createAgentForUser(USER_A_ID, readyInput("ready-key-006", { token: SECOND_TOKEN }), {
        createConnection: () => connection,
        env: KEYRING_ENV,
        now: () => new Date(NOW.getTime() + 2_000),
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: telegramValidator("654321"),
      }),
    ).rejects.toBeInstanceOf(AgentPersistenceError);

    await expect(countRows(connection, "agents")).resolves.toBe(1);
    await expect(countRows(connection, "agent_events")).resolves.toBe(1);
  });
});

function readyInput(
  idempotencyKey: string,
  overrides: { runnerId?: string | null; token?: string } = {},
) {
  return {
    name: "Ready Agent",
    templateKey: "research_agent" as const,
    runnerId: overrides.runnerId ?? null,
    launchMode: "ready" as const,
    idempotencyKey,
    openrouterModel: "openai/gpt-4.1-mini",
    openrouterApiKey: OPENROUTER_KEY,
    telegramBotToken: overrides.token ?? TOKEN,
    telegramAllowedUserIds: ["111111", "222222", "111111"],
  };
}

function telegramValidator(botId = "123456") {
  return vi.fn(async () => ({
    ok: true as const,
    bot: { botId, username: "Valid_bot" },
  }));
}

function incrementalRandomBytes() {
  let next = 1;

  return (size: number) => {
    const value = Buffer.alloc(size, next);
    next += 1;
    return value;
  };
}

async function seedForeignOnlineRunner(connection: DatabaseConnection) {
  const [runner] = await connection.db
    .insert(runners)
    .values({
      id: FOREIGN_RUNNER_ID,
      userId: USER_B_ID,
      name: "Foreign Runner",
      kind: "manual_vps",
      endpointUrl: "https://foreign-runner.example.com",
      status: "online",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning();

  if (!runner) {
    throw new Error("Expected runner insert.");
  }

  await connection.db.insert(runnerHeartbeats).values({
    runnerId: runner.id,
    status: "online",
    metadata: { metrics: { maxAgents: 2, runningAgents: 0 } },
    observedAt: NOW,
    createdAt: NOW,
  });
}

async function countRows(connection: DatabaseConnection, tableName: string): Promise<number> {
  const result = await connection.client.unsafe<{ count: string }[]>(
    `select count(*)::text as count from ${tableName}`,
  );

  return Number(result[0]?.count ?? 0);
}

async function resetReadyCreateTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_deployments, agent_secrets, backups, agent_approvals, agent_configs, agent_usage_periods, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runner_provisioning_events, runner_heartbeats, runner_credentials, runner_registration_tokens, runners, app_metadata, users restart identity cascade`;
}
