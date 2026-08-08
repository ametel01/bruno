import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyManagedRuntimeForUpdate,
  openManagedRuntimeSecretCircuit,
  persistManagedRuntimeOwnerIntent,
  reviseManagedRuntimeConfiguration,
} from "@/src/server/agents/agent-runtime-lifecycle";
import { MAX_RUNTIME_COUNTER } from "@/src/server/agents/agent-runtime-state";
import {
  AGENT_CREDENTIALS_UPDATED_EVENT_TYPE,
  replaceAgentSecretForUser,
  revokeAgentSecretForUser,
} from "@/src/server/agents/agent-secrets";
import { assignRunnerForHermesSetup } from "@/src/server/agents/hermes-setup-runner";
import { getAgentTemplateSnapshot } from "@/src/server/agents/templates";
import { updateAgentConfigForUser } from "@/src/server/agents/update-agent-config";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentDeployments,
  agentEvents,
  agentConfigs,
  agentRuntimeReconciliations,
  agents,
  runners,
  users,
} from "@/src/server/db/schema";

const USER_ID = "00000000-0000-4000-8000-000000000911";
const AGENT_ID = "00000000-0000-4000-8000-000000000912";
const RUNNER_ID = "00000000-0000-4000-8000-000000000913";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000914";
const OPERATION_ID = "00000000-0000-4000-8000-000000000915";
const NOW = new Date("2026-08-03T12:00:00.000Z");
const KEYRING_ENV = {
  BRUNO_AGENT_SECRET_ACTIVE_KEY_VERSION: "v1",
  BRUNO_AGENT_SECRET_KEYS_JSON: JSON.stringify({
    v1: Buffer.alloc(32, 9).toString("base64"),
  }),
};

describe("managed runtime lifecycle persistence", () => {
  let connection: DatabaseConnection;

  beforeAll(() => {
    connection = createDatabaseConnection();
  });

  beforeEach(async () => {
    await reset(connection);
    await seedReadyAgent(connection);
  });

  afterAll(async () => {
    await reset(connection);
    await connection.close();
  });

  it("fails closed when latest ready evidence has no accepted runtime correlation", async () => {
    const classification = await connection.db.transaction((tx) =>
      classifyManagedRuntimeForUpdate(tx, { agentId: AGENT_ID, userId: USER_ID }),
    );

    expect(classification).toEqual({ kind: "managed_unavailable" });
  });

  it("persists a new owner generation and clears stale work before returning", async () => {
    await seedRuntime(connection);
    const generation = await connection.db.transaction(async (tx) => {
      const classification = await classifyManagedRuntimeForUpdate(tx, {
        agentId: AGENT_ID,
        userId: USER_ID,
      });
      expect(classification.kind).toBe("managed_ready");
      if (classification.kind !== "managed_ready") {
        return null;
      }

      return persistManagedRuntimeOwnerIntent(tx, {
        agentId: AGENT_ID,
        userId: USER_ID,
        expectedGeneration: classification.runtime.generation,
        intent: "restart",
        now: NOW,
      });
    });

    expect(generation).toBe(1);
    const [runtime] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(runtime).toMatchObject({
      state: "recovering_stop",
      generation: 1,
      operationId: null,
      attemptCount: 0,
      recoveryCount: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: NOW,
    });
  });

  it("guards generation overflow without mutating the row", async () => {
    await seedRuntime(connection, { generation: MAX_RUNTIME_COUNTER });
    const result = await connection.db.transaction((tx) =>
      persistManagedRuntimeOwnerIntent(tx, {
        agentId: AGENT_ID,
        userId: USER_ID,
        expectedGeneration: MAX_RUNTIME_COUNTER,
        intent: "start",
        now: NOW,
      }),
    );

    expect(result).toBeNull();
    const [runtime] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(runtime?.generation).toBe(MAX_RUNTIME_COUNTER);
  });

  it("preserves a cleanup-only circuit across a config revision change", async () => {
    const circuitAt = new Date(NOW.getTime() - 1_000);
    await seedRuntime(connection, {
      generation: 3,
      state: "stopping",
      operationId: null,
      errorCode: "runtime_secret_unavailable",
      circuitOpenedAt: circuitAt,
      nextAttemptAt: NOW,
    });

    const result = await connection.db.transaction((tx) =>
      reviseManagedRuntimeConfiguration(tx, { agentId: AGENT_ID, userId: USER_ID, now: NOW }),
    );

    expect(result).toEqual({ changed: true, schedule: true });
    const [runtime] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(runtime).toMatchObject({
      state: "stopping",
      generation: 4,
      errorCode: "runtime_secret_unavailable",
      circuitOpenedAt: circuitAt,
      nextAttemptAt: NOW,
    });
    expect(runtime?.configRevision).toBe(`cfg-runtime-4-${NOW.getTime()}`);
  });

  it("turns a required-secret revoke into due cleanup-only stopping", async () => {
    await seedRuntime(connection);

    await expect(
      connection.db.transaction((tx) =>
        openManagedRuntimeSecretCircuit(tx, { agentId: AGENT_ID, userId: USER_ID, now: NOW }),
      ),
    ).resolves.toBe(true);

    const [runtime] = await connection.db.select().from(agentRuntimeReconciliations);
    const [agent] = await connection.db.select().from(agents);
    expect(runtime).toMatchObject({
      state: "stopping",
      generation: 1,
      errorCode: "runtime_secret_unavailable",
      circuitOpenedAt: NOW,
      nextAttemptAt: NOW,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(agent).toMatchObject({ status: "error", desiredStatus: "running" });
  });

  it("fails closed when Hermes setup sees corrupted managed-ready assignment state", async () => {
    await seedRuntime(connection);
    await connection.db.update(agents).set({ runnerId: null }).where(eq(agents.id, AGENT_ID));

    await expect(
      assignRunnerForHermesSetup(connection, { agentId: AGENT_ID, userId: USER_ID }),
    ).resolves.toEqual({ ok: false, reason: "agent_not_found" });

    const [agent] = await connection.db.select().from(agents);
    const [runtime] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(agent?.runnerId).toBeNull();
    expect(runtime).toMatchObject({ generation: 0, configRevision: "cfg-runtime-lifecycle-0" });
  });

  it("fences a managed config change without mutating the terminal deployment", async () => {
    await seedRuntime(connection);
    const scheduleRuntimeReconcile = vi.fn();

    const result = await updateAgentConfigForUser(
      USER_ID,
      AGENT_ID,
      { name: "Updated runtime lifecycle agent" },
      { createConnection: () => connection, now: () => NOW, scheduleRuntimeReconcile },
    );

    expect(result).toMatchObject({ ok: true, noOp: false });
    expect(scheduleRuntimeReconcile).toHaveBeenCalledWith(AGENT_ID);
    const [runtime] = await connection.db.select().from(agentRuntimeReconciliations);
    const [deployment] = await connection.db.select().from(agentDeployments);
    expect(runtime).toMatchObject({
      state: "recovering_stop",
      generation: 1,
      configRevision: `cfg-runtime-1-${NOW.getTime()}`,
      nextAttemptAt: NOW,
    });
    expect(deployment).toMatchObject({
      id: DEPLOYMENT_ID,
      stage: "ready",
      configRevision: "cfg-runtime-lifecycle-0",
      completedAt: NOW,
    });
  });

  it("fences secret replacement and queues cleanup-only stopping on revoke", async () => {
    await seedRuntime(connection);
    const scheduleRuntimeReconcile = vi.fn();

    await expect(
      replaceAgentSecretForUser(
        USER_ID,
        AGENT_ID,
        { kind: "openrouter_api_key", value: "sk-or-v1-runtime-secret-test-1234567890" },
        {
          createConnection: () => connection,
          env: KEYRING_ENV,
          now: () => NOW,
          scheduleRuntimeReconcile,
        },
      ),
    ).resolves.toMatchObject({ ok: true });
    let [runtime] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(runtime).toMatchObject({
      state: "recovering_stop",
      generation: 1,
      configRevision: `cfg-runtime-1-${NOW.getTime()}`,
    });

    await expect(
      revokeAgentSecretForUser(
        USER_ID,
        AGENT_ID,
        { kind: "openrouter_api_key" },
        {
          createConnection: () => connection,
          now: () => NOW,
          scheduleRuntimeReconcile,
        },
      ),
    ).resolves.toMatchObject({ ok: true });
    [runtime] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(runtime).toMatchObject({
      state: "stopping",
      generation: 2,
      errorCode: "runtime_secret_unavailable",
      circuitOpenedAt: NOW,
      nextAttemptAt: NOW,
    });
    expect(scheduleRuntimeReconcile).toHaveBeenCalledTimes(2);
    const events = await connection.db.select().from(agentEvents);
    expect(
      events.filter((event) => event.type === AGENT_CREDENTIALS_UPDATED_EVENT_TYPE),
    ).toHaveLength(2);
    expect(events.every((event) => Object.keys(event.metadata).length === 0)).toBe(true);
  });
});

async function seedReadyAgent(connection: DatabaseConnection): Promise<void> {
  await connection.db.insert(users).values({ id: USER_ID });
  await connection.db.insert(runners).values({
    id: RUNNER_ID,
    userId: USER_ID,
    name: "Runtime lifecycle runner",
    kind: "manual_vps",
    endpointUrl: "http://127.0.0.1:3045",
    status: "online",
  });
  await connection.db.insert(agents).values({
    id: AGENT_ID,
    userId: USER_ID,
    runnerId: RUNNER_ID,
    name: "Runtime lifecycle agent",
    templateKey: "research_agent",
    templateSnapshotJson: getAgentTemplateSnapshot("research_agent"),
    status: "running",
    desiredStatus: "running",
  });
  await connection.db.insert(agentConfigs).values({
    agentId: AGENT_ID,
    systemPrompt: "Runtime lifecycle test prompt.",
    modelProvider: "openrouter",
    modelName: "openai/gpt-4.1-mini",
    maxDailySpendCents: 1_000,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await connection.db.insert(agentDeployments).values({
    id: DEPLOYMENT_ID,
    agentId: AGENT_ID,
    userId: USER_ID,
    stage: "ready",
    configRevision: "cfg-runtime-lifecycle-0",
    idempotencyKey: "Runtime-Lifecycle-001",
    runnerOperationId: OPERATION_ID,
    runnerAcceptedAt: NOW,
    canaryState: "passed",
    canaryAttemptedAt: NOW,
    canaryCompletedAt: NOW,
    completedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function seedRuntime(
  connection: DatabaseConnection,
  overrides: Partial<typeof agentRuntimeReconciliations.$inferInsert> = {},
): Promise<void> {
  await connection.db.insert(agentRuntimeReconciliations).values({
    agentId: AGENT_ID,
    userId: USER_ID,
    state: "observing",
    generation: 0,
    configRevision: "cfg-runtime-lifecycle-0",
    operationId: OPERATION_ID,
    lastObservedAt: NOW,
    lastReadyAt: NOW,
    nextAttemptAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table agent_runtime_reconciliations, agent_deployments, agents, runners, users restart identity cascade",
  );
}
