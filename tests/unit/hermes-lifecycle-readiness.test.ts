import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentForDevelopmentUser } from "@/src/server/agents/create-agent";
import {
  generateApiServerKeyForUser,
  replaceAgentSecretForUser,
} from "@/src/server/agents/agent-secrets";
import {
  type AgentLifecycleDependencies,
  deleteAgentForDevelopmentUser,
  restartAgentForDevelopmentUser,
  startAgentForDevelopmentUser,
} from "@/src/server/agents/lifecycle";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentConfigs,
  agentEvents,
  agents,
  runnerHeartbeats,
  runners,
} from "@/src/server/db/schema";
import type { ManualRunnerRecord } from "@/src/server/runners/manual-runner-persistence";

const KEYRING_ENV = {
  AGENTBAY_AGENT_SECRET_ACTIVE_KEY_VERSION: "v1",
  AGENTBAY_AGENT_SECRET_KEYS_JSON: JSON.stringify({
    v1: Buffer.alloc(32, 23).toString("base64url"),
  }),
};

describe("Hermes lifecycle readiness", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetHermesLifecycleTables(connection);
  });

  afterEach(async () => {
    await resetHermesLifecycleTables(connection);
    await connection.close();
  });

  it("blocks assigned DigitalOcean starts before Hermes setup and never calls the runner", async () => {
    const created = await createAgentForDevelopmentUser(
      { name: "Missing Hermes Agent", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const runnerId = await insertReadyCloudRunner(connection, created.agent.userId);
    const calls: string[] = [];

    await assignRunner(connection, created.agent.id, runnerId);

    const result = await startAgentForDevelopmentUser(created.agent.id, {
      createConnection: () => connection,
      manualRunnerAdapter: () => lifecycleRunnerStub(calls),
      runnerAdapter: lifecycleRunnerStub(calls),
    });

    expect(result).toEqual({
      ok: false,
      reason: "hermes_setup_incomplete",
      message: "Run Hermes setup before starting this agent.",
    });
    expect(calls).toEqual([]);
  });

  it("starts an assigned DigitalOcean agent after Hermes setup is complete", async () => {
    const created = await createAgentForDevelopmentUser(
      { name: "Ready Hermes Agent", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const runnerId = await insertReadyCloudRunner(connection, created.agent.userId);
    const calls: string[] = [];

    await assignRunner(connection, created.agent.id, runnerId);
    await configureHermesAgent(connection, created.agent.userId, created.agent.id);

    const result = await startAgentForDevelopmentUser(created.agent.id, {
      createConnection: () => connection,
      launchSpec: {
        env: KEYRING_ENV,
        requestId: () => "hermes-start-request",
      },
      manualRunnerAdapter: (runner) => lifecycleRunnerStub(calls, runner),
      runnerAdapter: lifecycleRunnerStub(calls),
      now: () => new Date("2026-07-14T02:00:00.000Z"),
    });

    expect(result).toMatchObject({
      ok: true,
      agent: {
        id: created.agent.id,
        status: "running",
      },
    });
    expect(calls).toEqual([`start:${created.agent.id}`, `logs:${created.agent.id}`]);
  });

  it("records agent.error when Hermes readiness fails after container start", async () => {
    const created = await createAgentForDevelopmentUser(
      { name: "Readiness Failure Hermes Agent", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const runnerId = await insertReadyCloudRunner(connection, created.agent.userId);
    const calls: string[] = [];

    await assignRunner(connection, created.agent.id, runnerId);
    await configureHermesAgent(connection, created.agent.userId, created.agent.id);

    const result = await startAgentForDevelopmentUser(created.agent.id, {
      createConnection: () => connection,
      launchSpec: {
        env: KEYRING_ENV,
        requestId: () => "hermes-readiness-failure-request",
      },
      manualRunnerAdapter: () => readinessFailingRunnerStub(calls),
      runnerAdapter: lifecycleRunnerStub(calls),
      now: () => new Date("2026-07-14T02:05:00.000Z"),
    });
    const [persistedAgent] = await connection.db
      .select({ status: agents.status, statusReason: agents.statusReason })
      .from(agents)
      .where(eq(agents.id, created.agent.id))
      .limit(1);
    const events = await connection.db
      .select({ type: agentEvents.type, metadata: agentEvents.metadata })
      .from(agentEvents)
      .where(eq(agentEvents.agentId, created.agent.id));

    expect(result).toEqual({ ok: false, reason: "runner_start_failed" });
    expect(persistedAgent).toEqual({
      status: "error",
      statusReason:
        "Hermes container started, but readiness did not complete. Check captured runner logs for details.",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "agent.error",
        metadata: { reason: "hermes_readiness_failed" },
      }),
    );
    expect(calls).toEqual([`start:${created.agent.id}`]);
  });

  it("blocks assigned DigitalOcean restarts when a required Hermes secret is missing", async () => {
    const created = await createAgentForDevelopmentUser(
      { name: "Restart Hermes Agent", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const runnerId = await insertReadyCloudRunner(connection, created.agent.userId);
    const calls: string[] = [];

    await assignRunner(connection, created.agent.id, runnerId);
    await connection.db
      .update(agentConfigs)
      .set({
        modelProvider: "openrouter",
        modelName: "openai/gpt-4.1-mini",
        updatedAt: new Date("2026-07-14T01:20:00.000Z"),
      })
      .where(eq(agentConfigs.agentId, created.agent.id));
    await replaceAgentSecretForUser(
      created.agent.userId,
      created.agent.id,
      {
        kind: "openrouter_api_key",
        value: "sk-or-v1-1234567890abcdefghijklmnopqrstuvwxyz",
      },
      { createConnection: () => connection, env: KEYRING_ENV },
    );
    await connection.db
      .update(agents)
      .set({ status: "running", statusReason: "Hermes is running." })
      .where(eq(agents.id, created.agent.id));

    const result = await restartAgentForDevelopmentUser(created.agent.id, {
      createConnection: () => connection,
      manualRunnerAdapter: () => lifecycleRunnerStub(calls),
      runnerAdapter: lifecycleRunnerStub(calls),
    });

    expect(result).toEqual({
      ok: false,
      reason: "hermes_setup_incomplete",
      message: "Run Hermes setup before starting this agent.",
    });
    expect(calls).toEqual([]);
  });

  it("cleans assigned Hermes runner state before deleting the agent", async () => {
    const created = await createAgentForDevelopmentUser(
      { name: "Delete Hermes Agent", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const runnerId = await insertReadyCloudRunner(connection, created.agent.userId);
    const calls: string[] = [];

    await assignRunner(connection, created.agent.id, runnerId);

    const result = await deleteAgentForDevelopmentUser(created.agent.id, {
      createConnection: () => connection,
      manualRunnerAdapter: () => cleanupCapableRunnerStub(calls),
      runnerAdapter: lifecycleRunnerStub(calls),
      now: () => new Date("2026-07-14T02:10:00.000Z"),
    });

    expect(result).toMatchObject({
      ok: true,
      agent: {
        id: created.agent.id,
      },
    });
    expect(calls).toEqual([`cleanup:${created.agent.id}`]);
  });
});

async function insertReadyCloudRunner(
  connection: DatabaseConnection,
  userId: string,
): Promise<string> {
  const now = new Date("2026-07-14T01:00:00.000Z");
  const [runner] = await connection.db
    .insert(runners)
    .values({
      userId,
      name: "Hermes Cloud Runner",
      kind: "digitalocean",
      endpointUrl: "https://runner.example.com",
      status: "online",
      provider: "digitalocean",
      providerResourceId: "do-hermes-test",
      region: "sfo3",
      sizeSlug: "s-1vcpu-2gb",
      image: "ubuntu-24-04-x64",
      provisioningStatus: "ready",
      provisioningStartedAt: now,
      provisioningCompletedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: runners.id });

  if (!runner) {
    throw new Error("Runner insert returned no row.");
  }

  await connection.db.insert(runnerHeartbeats).values({
    runnerId: runner.id,
    status: "online",
    metadata: {
      metrics: {
        maxAgents: 2,
        runningAgents: 0,
      },
    },
    observedAt: new Date("2099-01-01T00:00:00.000Z"),
    createdAt: new Date("2099-01-01T00:00:00.000Z"),
  });

  return runner.id;
}

async function assignRunner(
  connection: DatabaseConnection,
  agentId: string,
  runnerId: string,
): Promise<void> {
  await connection.db.update(agents).set({ runnerId }).where(eq(agents.id, agentId));
}

async function configureHermesAgent(
  connection: DatabaseConnection,
  userId: string,
  agentId: string,
): Promise<void> {
  await connection.db
    .update(agentConfigs)
    .set({
      modelProvider: "openrouter",
      modelName: "openai/gpt-4.1-mini",
      updatedAt: new Date("2026-07-14T01:10:00.000Z"),
    })
    .where(eq(agentConfigs.agentId, agentId));

  await replaceAgentSecretForUser(
    userId,
    agentId,
    { kind: "openrouter_api_key", value: "sk-or-v1-1234567890abcdefghijklmnopqrstuvwxyz" },
    {
      createConnection: () => connection,
      env: KEYRING_ENV,
      randomBytes: (size) => Buffer.alloc(size, 1),
    },
  );
  await replaceAgentSecretForUser(
    userId,
    agentId,
    { kind: "telegram_bot_token", value: "123456:abcdefghijklmnopqrstuvwxyz" },
    {
      createConnection: () => connection,
      env: KEYRING_ENV,
      randomBytes: (size) => Buffer.alloc(size, 2),
    },
  );
  await replaceAgentSecretForUser(
    userId,
    agentId,
    { kind: "telegram_allowed_users", value: "123456789,987654321" },
    {
      createConnection: () => connection,
      env: KEYRING_ENV,
      randomBytes: (size) => Buffer.alloc(size, 3),
    },
  );
  await generateApiServerKeyForUser(userId, agentId, {
    createConnection: () => connection,
    env: KEYRING_ENV,
    randomBytes: (size) => Buffer.alloc(size, 4),
  });
}

function lifecycleRunnerStub(
  calls: string[],
  runner: ManualRunnerRecord = {
    id: "00000000-0000-4000-8000-000000000701",
    userId: "00000000-0000-4000-8000-000000000702",
    name: "Hermes Cloud Runner",
    kind: "digitalocean",
    endpointUrl: "https://runner.example.com",
    status: "online",
    createdAt: "2026-07-14T01:00:00.000Z",
    updatedAt: "2026-07-14T01:00:00.000Z",
    deletedAt: null,
  },
): NonNullable<AgentLifecycleDependencies["runnerAdapter"]> {
  return {
    start: vi.fn(async (agentId: string) => {
      calls.push(`start:${agentId}`);
      return {
        ok: true as const,
        runner,
        container: { id: `hermes-${agentId}`, status: "running" },
      };
    }),
    stop: vi.fn(async (agentId: string) => {
      calls.push(`stop:${agentId}`);
      return {
        ok: true as const,
        runner,
        containers: [{ id: `hermes-${agentId}`, status: "exited" }],
      };
    }),
    restart: vi.fn(async (agentId: string) => {
      calls.push(`restart:${agentId}`);
      return {
        ok: true as const,
        runner,
        container: { id: `hermes-${agentId}`, status: "running" },
      };
    }),
    status: vi.fn(async (agentId: string) => {
      calls.push(`status:${agentId}`);
      return {
        ok: true as const,
        runner,
        containers: [{ id: `hermes-${agentId}`, status: "running" }],
      };
    }),
    streamLogs: vi.fn(async (input: { agentId: string }) => {
      calls.push(`logs:${input.agentId}`);
      return { logs: [], nextAfter: null };
    }),
  };
}

function readinessFailingRunnerStub(
  calls: string[],
): NonNullable<AgentLifecycleDependencies["runnerAdapter"]> {
  return {
    ...lifecycleRunnerStub(calls),
    start: vi.fn(async (agentId: string) => {
      calls.push(`start:${agentId}`);
      return { ok: false as const, reason: "runner_readiness_failed" as const };
    }),
  };
}

function cleanupCapableRunnerStub(calls: string[]): NonNullable<
  AgentLifecycleDependencies["runnerAdapter"]
> & {
  cleanup(agentId: string): Promise<{ ok: true }>;
} {
  const adapter = lifecycleRunnerStub(calls) as NonNullable<
    AgentLifecycleDependencies["runnerAdapter"]
  > & {
    cleanup(agentId: string): Promise<{ ok: true }>;
  };

  adapter.cleanup = vi.fn(async (agentId: string) => {
    calls.push(`cleanup:${agentId}`);
    return { ok: true as const };
  });

  return adapter;
}

async function resetHermesLifecycleTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_secrets, backups, agent_approvals, agent_configs, agent_usage_periods, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runner_heartbeats, runners, app_metadata, users restart identity cascade`;
}
