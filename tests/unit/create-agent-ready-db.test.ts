import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSecretKeyringError } from "@/src/server/agents/agent-secrets";
import { listModelConnectionsForUser } from "@/src/server/agents/model-connections";
import {
  AgentPersistenceError,
  AgentRunnerAssignmentError,
  AgentRunnerProvisioningError,
  type ReadyCreateInsertBoundary,
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
const OPENAI_KEY_FIXTURE = ["sk", "fixture", "abcdefghijklmnopqrstuvwxyz1234567890"].join("-");
const RUNNER_IMAGE = `ghcr.io/ametel01/agentbay-runner:${"a".repeat(40)}@sha256:${"b".repeat(64)}`;
const KEYRING_ENV = {
  AGENTBAY_READY_AGENT_CREATION_ENABLED: "true",
  AGENTBAY_DIGITALOCEAN_TOKEN: "provider-token-present",
  AGENTBAY_RUNNER_BEARER_TOKEN: "runner-token-present",
  AGENTBAY_RUNNER_IMAGE: RUNNER_IMAGE,
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
    await seedReadyCreateUsers(connection);
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
        assistant: { id: "chatgpt", displayName: "ChatGPT" },
        telegramBot: { id: "123456", username: "Valid_bot" },
      },
    });
    expect(JSON.stringify(result)).not.toContain(OPENAI_KEY_FIXTURE);
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
      modelProvider: "openai-api",
      modelName: "gpt-5.4",
      systemPrompt: getAgentTemplateSnapshot("research_agent").defaultSystemPrompt,
    });
    expect(secrets).toHaveLength(4);
    expect(secrets.map((secret) => secret.kind).sort()).toEqual([
      "api_server_key",
      "openai_api_key",
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
        assistant: "chatgpt",
        runnerAssignment: "none",
        deploymentId: deployment?.id,
      },
    });
    expect(JSON.stringify(event?.metadata)).not.toContain("123456");
    expect(JSON.stringify(event?.metadata)).not.toContain("ready-key-001");
  });

  it("rejects creation before persistence when no runner can be provisioned safely", async () => {
    const validator = telegramValidator();

    await expect(
      createAgentForUser(USER_A_ID, readyInput("ready-key-provider-missing"), {
        createConnection: () => connection,
        env: {
          ...KEYRING_ENV,
          AGENTBAY_DIGITALOCEAN_TOKEN: undefined,
          AGENTBAY_RUNNER_BEARER_TOKEN: undefined,
          AGENTBAY_RUNNER_IMAGE: undefined,
        },
        now: () => NOW,
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: validator,
      }),
    ).rejects.toMatchObject({
      name: AgentRunnerProvisioningError.name,
      reason: "provider_not_configured",
    });

    expect(validator).not.toHaveBeenCalled();
    await expect(countRows(connection, "agents")).resolves.toBe(0);
    await expect(countRows(connection, "agent_deployments")).resolves.toBe(0);
  });

  it("uses an available runner without requiring new Droplet provisioning configuration", async () => {
    const runnerId = "00000000-0000-4000-8000-000000000405";
    await seedOnlineRunner(connection, { runnerId, userId: USER_A_ID });

    const result = await createAgentForUser(USER_A_ID, readyInput("ready-key-existing-runner"), {
      createConnection: () => connection,
      env: {
        ...KEYRING_ENV,
        AGENTBAY_DIGITALOCEAN_TOKEN: undefined,
        AGENTBAY_RUNNER_BEARER_TOKEN: undefined,
        AGENTBAY_RUNNER_IMAGE: undefined,
      },
      now: () => NOW,
      randomBytes: incrementalRandomBytes(),
      telegramBotValidator: telegramValidator(),
    });

    expect(result.agent.runnerId).toBe(runnerId);
  });

  it("creates Claude with the direct Anthropic binding and encrypted Anthropic key", async () => {
    const anthropicKey = `sk-ant-${"c".repeat(32)}`;
    const result = await createAgentForUser(
      USER_A_ID,
      readyInput("ready-key-claude", { assistant: "claude", modelApiKey: anthropicKey }),
      {
        createConnection: () => connection,
        env: KEYRING_ENV,
        now: () => NOW,
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: telegramValidator(),
      },
    );

    expect(result).toMatchObject({
      agent: { assistant: { id: "claude", displayName: "Claude" } },
    });
    const [config] = await connection.db.select().from(agentConfigs);
    const secrets = await connection.db.select().from(agentSecrets);

    expect(config).toMatchObject({
      modelProvider: "anthropic",
      modelName: "claude-sonnet-4-6",
    });
    expect(secrets.map((secret) => secret.kind)).toContain("anthropic_api_key");
    expect(JSON.stringify(result)).not.toContain(anthropicKey);
  });

  it("reuses an owner-scoped encrypted ChatGPT connection without returning the key", async () => {
    await createAgentForUser(USER_A_ID, readyInput("ready-key-reuse-1"), {
      createConnection: () => connection,
      env: KEYRING_ENV,
      now: () => NOW,
      randomBytes: incrementalRandomBytes(),
      telegramBotValidator: telegramValidator(),
    });
    await expect(
      listModelConnectionsForUser(USER_A_ID, { createConnection: () => connection }),
    ).resolves.toMatchObject([
      { assistant: "chatgpt", status: "action_required" },
      { assistant: "claude", status: "action_required" },
    ]);
    await connection.db.update(agentDeployments).set({
      stage: "ready",
      runnerOperationId: "88888888-8888-4888-8888-888888888888",
      runnerAcceptedAt: NOW,
      canaryState: "passed",
      canaryAttemptedAt: NOW,
      canaryCompletedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    });

    const connectionViews = await listModelConnectionsForUser(USER_A_ID, {
      createConnection: () => connection,
    });
    expect(connectionViews).toMatchObject([
      { assistant: "chatgpt", status: "connected" },
      { assistant: "claude", status: "action_required" },
    ]);
    expect(JSON.stringify(connectionViews)).not.toContain(OPENAI_KEY_FIXTURE);

    const reusedInput = readyInput("ready-key-reuse-2", {
      token: SECOND_TOKEN,
      modelApiKey: null,
    });
    const reused = await createAgentForUser(USER_A_ID, reusedInput, {
      createConnection: () => connection,
      env: KEYRING_ENV,
      now: () => new Date(NOW.getTime() + 1_000),
      randomBytes: incrementalRandomBytes(),
      telegramBotValidator: telegramValidator("654321"),
    });

    expect(reused).toMatchObject({ agent: { assistant: { id: "chatgpt" } } });
    expect(JSON.stringify(reused)).not.toContain(OPENAI_KEY_FIXTURE);
    const modelSecrets = await connection.db
      .select()
      .from(agentSecrets)
      .where(eq(agentSecrets.kind, "openai_api_key"));
    expect(modelSecrets).toHaveLength(2);

    const foreignInput = readyInput("ready-key-reuse-3", {
      token: "777777:abcdefghijklmnopqrstuvwxyz",
      modelApiKey: null,
    });
    await expect(
      createAgentForUser(USER_B_ID, foreignInput, {
        createConnection: () => connection,
        env: KEYRING_ENV,
        now: () => new Date(NOW.getTime() + 2_000),
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: telegramValidator("777777"),
      }),
    ).rejects.toMatchObject({ name: "ReadyAgentValidationError" });
  });

  it("replays an existing ready deployment before flag and credential validation", async () => {
    const validator = telegramValidator();
    const onReadyDeploymentCommitted = vi.fn();
    const created = await createAgentForUser(USER_A_ID, readyInput("ready-key-002"), {
      createConnection: () => connection,
      env: KEYRING_ENV,
      now: () => NOW,
      randomBytes: incrementalRandomBytes(),
      telegramBotValidator: validator,
      onReadyDeploymentCommitted,
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
        onReadyDeploymentCommitted,
      },
    );

    expect(replay).toEqual(created);
    expect(validator).toHaveBeenCalledTimes(1);
    expect(onReadyDeploymentCommitted).toHaveBeenCalledOnce();
    expect(onReadyDeploymentCommitted).toHaveBeenCalledWith(
      "deployment" in created ? created.deployment.id : null,
    );
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

  it("rolls back every logical ready-create group at each insert boundary", async () => {
    const boundaries: ReadyCreateInsertBoundary[] = [
      "config",
      "secret:openai_api_key",
      "secret:telegram_bot_token",
      "secret:telegram_allowed_users",
      "secret:api_server_key",
      "deployment",
      "event",
    ];

    for (const boundary of boundaries) {
      await resetReadyCreateTables(connection);
      await seedReadyCreateUsers(connection);

      await expect(
        createAgentForUser(USER_A_ID, readyInput(`rollback-${boundary.replaceAll(":", "-")}`), {
          createConnection: () => connection,
          env: KEYRING_ENV,
          now: () => NOW,
          randomBytes: incrementalRandomBytes(),
          telegramBotValidator: telegramValidator(),
          readyCreateTestHooks: {
            beforeInsertBoundary: (actualBoundary) => {
              if (actualBoundary === boundary) {
                throw new Error(`injected ${boundary} failure`);
              }
            },
          },
        }),
      ).rejects.toBeInstanceOf(AgentPersistenceError);

      await expect(countReadyCreateGroups(connection)).resolves.toEqual({
        agents: 0,
        configs: 0,
        secrets: 0,
        deployments: 0,
        events: 0,
      });
    }
  });

  it("serializes same-key concurrent ready creates into one durable result", async () => {
    const firstConnection = createDatabaseConnection();
    const secondConnection = createDatabaseConnection();
    const barrier = createAsyncBarrier(2);

    try {
      const [first, second] = await Promise.all([
        createAgentForUser(USER_A_ID, readyInput("same-key-concurrent"), {
          createConnection: () => firstConnection,
          env: KEYRING_ENV,
          now: () => NOW,
          randomBytes: incrementalRandomBytes(),
          telegramBotValidator: telegramValidator("123456", barrier),
        }),
        createAgentForUser(USER_A_ID, readyInput("same-key-concurrent"), {
          createConnection: () => secondConnection,
          env: KEYRING_ENV,
          now: () => new Date(NOW.getTime() + 1_000),
          randomBytes: incrementalRandomBytes(),
          telegramBotValidator: telegramValidator("123456", barrier),
        }),
      ]);

      expect(second).toEqual(first);
      await expect(countReadyCreateGroups(connection)).resolves.toEqual({
        agents: 1,
        configs: 1,
        secrets: 4,
        deployments: 1,
        events: 1,
      });
    } finally {
      await firstConnection.close();
      await secondConnection.close();
    }
  });

  it("rolls back one side of concurrent active Telegram token and subject races", async () => {
    const tokenBarrier = createAsyncBarrier(2);
    await assertOneTelegramRaceRollsBack({
      observerConnection: connection,
      firstInput: readyInput("token-race-a"),
      secondInput: readyInput("token-race-b"),
      firstValidator: telegramValidator("123456", tokenBarrier),
      secondValidator: telegramValidator("123456", tokenBarrier),
    });

    await resetReadyCreateTables(connection);
    await seedReadyCreateUsers(connection);

    const subjectBarrier = createAsyncBarrier(2);
    await assertOneTelegramRaceRollsBack({
      observerConnection: connection,
      firstInput: readyInput("subject-race-a", { token: TOKEN }),
      secondInput: readyInput("subject-race-b", { token: SECOND_TOKEN }),
      firstValidator: telegramValidator("123456", subjectBarrier),
      secondValidator: telegramValidator("123456", subjectBarrier),
    });
  });

  it("isolates idempotency keys by user and replays only the owning deployment", async () => {
    const first = await createAgentForUser(USER_A_ID, readyInput("shared-user-key"), {
      createConnection: () => connection,
      env: KEYRING_ENV,
      now: () => NOW,
      randomBytes: incrementalRandomBytes(),
      telegramBotValidator: telegramValidator("123456"),
    });
    const second = await createAgentForUser(
      USER_B_ID,
      readyInput("shared-user-key", { token: SECOND_TOKEN }),
      {
        createConnection: () => connection,
        env: KEYRING_ENV,
        now: () => new Date(NOW.getTime() + 1_000),
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: telegramValidator("654321"),
      },
    );
    const secondReplay = await createAgentForUser(
      USER_B_ID,
      {
        name: "Changed User B Body",
        templateKey: "github_issue_agent",
        runnerId: null,
        launchMode: "ready",
        idempotencyKey: "shared-user-key",
      },
      {
        createConnection: () => connection,
        env: { ...KEYRING_ENV, AGENTBAY_READY_AGENT_CREATION_ENABLED: "false" },
        telegramBotValidator: vi.fn(),
      },
    );

    expect(secondReplay).toEqual(second);
    expect(second.agent.id).not.toBe(first.agent.id);
    expect(second.agent.userId).toBe(USER_B_ID);
    await expect(countReadyCreateGroups(connection)).resolves.toEqual({
      agents: 2,
      configs: 2,
      secrets: 8,
      deployments: 2,
      events: 2,
    });
  });

  it("assigns only an owned requested runner and conceals the same runner from another user", async () => {
    const runnerId = "00000000-0000-4000-8000-000000000404";
    await seedOnlineRunner(connection, { runnerId, userId: USER_A_ID });

    const assigned = await createAgentForUser(
      USER_A_ID,
      readyInput("owned-runner-ready", { runnerId }),
      {
        createConnection: () => connection,
        env: KEYRING_ENV,
        now: () => NOW,
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: telegramValidator(),
      },
    );
    const validator = telegramValidator("654321");

    expect(assigned.agent.runnerId).toBe(runnerId);
    await expect(
      createAgentForUser(
        USER_B_ID,
        readyInput("foreign-runner-ready", { runnerId, token: SECOND_TOKEN }),
        {
          createConnection: () => connection,
          env: KEYRING_ENV,
          now: () => new Date(NOW.getTime() + 1_000),
          randomBytes: incrementalRandomBytes(),
          telegramBotValidator: validator,
        },
      ),
    ).rejects.toBeInstanceOf(AgentRunnerAssignmentError);
    expect(validator).not.toHaveBeenCalled();
    await expect(countReadyCreateGroups(connection)).resolves.toEqual({
      agents: 1,
      configs: 1,
      secrets: 4,
      deployments: 1,
      events: 1,
    });
  });
});

function readyInput(
  idempotencyKey: string,
  overrides: {
    runnerId?: string | null;
    token?: string;
    assistant?: "chatgpt" | "claude";
    modelApiKey?: string | null;
  } = {},
) {
  return {
    name: "Ready Agent",
    templateKey: "research_agent" as const,
    runnerId: overrides.runnerId ?? null,
    launchMode: "ready" as const,
    idempotencyKey,
    assistant: overrides.assistant ?? "chatgpt",
    ...(overrides.modelApiKey === null
      ? {}
      : { modelApiKey: overrides.modelApiKey ?? OPENAI_KEY_FIXTURE }),
    telegramBotToken: overrides.token ?? TOKEN,
    telegramAllowedUserIds: ["111111", "222222", "111111"],
  };
}

function telegramValidator(botId = "123456", barrier?: () => Promise<void>) {
  return vi.fn(async () => {
    await barrier?.();

    return {
      ok: true as const,
      bot: { botId, username: "Valid_bot" },
    };
  });
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
  await seedOnlineRunner(connection, { runnerId: FOREIGN_RUNNER_ID, userId: USER_B_ID });
}

async function seedOnlineRunner(
  connection: DatabaseConnection,
  input: { runnerId: string; userId: string },
) {
  const [runner] = await connection.db
    .insert(runners)
    .values({
      id: input.runnerId,
      userId: input.userId,
      name: "Ready Runner",
      kind: "manual_vps",
      endpointUrl: `https://runner-${input.runnerId.slice(-4)}.example.com`,
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

async function countReadyCreateGroups(connection: DatabaseConnection) {
  const [agentCount, configCount, secretCount, deploymentCount, eventCount] = await Promise.all([
    countRows(connection, "agents"),
    countRows(connection, "agent_configs"),
    countRows(connection, "agent_secrets"),
    countRows(connection, "agent_deployments"),
    countRows(connection, "agent_events"),
  ]);

  return {
    agents: agentCount,
    configs: configCount,
    secrets: secretCount,
    deployments: deploymentCount,
    events: eventCount,
  };
}

async function assertOneTelegramRaceRollsBack(input: {
  observerConnection: DatabaseConnection;
  firstInput: ReturnType<typeof readyInput>;
  secondInput: ReturnType<typeof readyInput>;
  firstValidator: ReturnType<typeof telegramValidator>;
  secondValidator: ReturnType<typeof telegramValidator>;
}) {
  const firstConnection = createDatabaseConnection();
  const secondConnection = createDatabaseConnection();

  try {
    const settled = await Promise.allSettled([
      createAgentForUser(USER_A_ID, input.firstInput, {
        createConnection: () => firstConnection,
        env: KEYRING_ENV,
        now: () => NOW,
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: input.firstValidator,
      }),
      createAgentForUser(USER_A_ID, input.secondInput, {
        createConnection: () => secondConnection,
        env: KEYRING_ENV,
        now: () => new Date(NOW.getTime() + 1_000),
        randomBytes: incrementalRandomBytes(),
        telegramBotValidator: input.secondValidator,
      }),
    ]);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(TelegramBotInUseError);
    await expect(countReadyCreateGroups(input.observerConnection)).resolves.toEqual({
      agents: 1,
      configs: 1,
      secrets: 4,
      deployments: 1,
      events: 1,
    });
  } finally {
    await firstConnection.close();
    await secondConnection.close();
  }
}

async function seedReadyCreateUsers(connection: DatabaseConnection): Promise<void> {
  await connection.db.insert(users).values([{ id: USER_A_ID }, { id: USER_B_ID }]);
}

function createAsyncBarrier(count: number): () => Promise<void> {
  let waiting = 0;
  let release: (() => void) | null = null;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return async () => {
    waiting += 1;

    if (waiting === count) {
      release?.();
    }

    await released;
  };
}

async function resetReadyCreateTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_deployments, agent_secrets, backups, agent_approvals, agent_configs, agent_usage_periods, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runner_provisioning_events, runner_heartbeats, runner_credentials, runner_registration_tokens, runners, app_metadata, users restart identity cascade`;
}
