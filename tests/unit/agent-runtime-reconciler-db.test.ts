import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_HERMES_WORKLOAD_IMAGE } from "@/src/runner-service/constants";
import type { RunnerDurableStatusSnapshot } from "@/src/runner-service/runner-contracts";
import { MANAGED_AGENT_LAUNCH_SPEC_VERSION } from "@/src/server/agents/agent-launch-spec";
import {
  type AgentRuntimeReconcilerDependencies,
  reconcileTargetAgentRuntime,
  type RuntimeRunnerAdapter,
} from "@/src/server/agents/agent-runtime-reconciler";
import { initializeAgentRuntimeAfterDeploymentReady } from "@/src/server/agents/agent-runtime-store";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentDeployments,
  agentEvents,
  agentRuntimeReconciliations,
  agents,
  agentUsagePeriods,
  runners,
  users,
} from "@/src/server/db/schema";
import type { ManualRunnerRecord } from "@/src/server/runners/manual-runner-persistence";

const execFileAsync = promisify(execFile);
const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://bruno:bruno@127.0.0.1:54329/bruno";
const USER_ID = "00000000-0000-4000-8000-000000009501";
const RUNNER_ID = "00000000-0000-4000-8000-000000009502";
const AGENT_ID = "00000000-0000-4000-8000-000000009503";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000009504";
const OPERATION_ID = "00000000-0000-4000-8000-000000009505";
const REVISION = "cfg-runtime-db";
const READY_AT = new Date("2026-08-03T08:00:00.000Z");

describe("agent runtime reconciler PostgreSQL integration", () => {
  let databaseName: string;
  let databaseUrl: string;
  let connection: DatabaseConnection;

  beforeAll(async () => {
    ({ databaseName, databaseUrl } = await createDisposableDatabase());
    await runDbMigrate(databaseUrl);
    connection = createDatabaseConnection(databaseUrl);
    await seedReadyRuntime(connection);
  });

  afterAll(async () => {
    await connection?.close();
    if (databaseName) {
      await dropDisposableDatabase(databaseName);
    }
  });

  it("serializes competing reconcilers and atomically segments usage/events at control-plane time", async () => {
    const first = createDatabaseConnection(databaseUrl);
    const second = createDatabaseConnection(databaseUrl);
    const status = vi.fn(async () => ({
      ok: true,
      runner: runnerRecord(),
      snapshot: readySnapshot(),
    }));
    const dependencies = (db: DatabaseConnection): AgentRuntimeReconcilerDependencies => ({
      createConnection: () => db,
      now: () => new Date(READY_AT.getTime() + 1_000),
      loadContext: vi.fn(async () => ({
        agentStatus: "running" as const,
        runner: runnerRecord(),
        runnerAvailability: "eligible" as const,
      })),
      manualRunnerAdapter: vi.fn(
        () =>
          ({
            status,
            start: vi.fn(),
            stop: vi.fn(),
          }) as unknown as RuntimeRunnerAdapter,
      ),
    });

    try {
      const results = await Promise.all([
        reconcileTargetAgentRuntime(AGENT_ID, dependencies(first)),
        reconcileTargetAgentRuntime(AGENT_ID, dependencies(second)),
      ]);
      expect(results.map((result) => result.processed).sort()).toEqual([0, 1]);
      expect(status).toHaveBeenCalledOnce();
    } finally {
      await Promise.all([first.close(), second.close()]);
    }

    const [runtimeAfterReady] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(runtimeAfterReady).toMatchObject({
      state: "observing",
      attemptCount: 0,
      errorCode: null,
      lastObservedAt: new Date(READY_AT.getTime() + 1_000),
      lastReadyAt: new Date(READY_AT.getTime() + 1_000),
      nextAttemptAt: new Date(READY_AT.getTime() + 61_000),
    });
    expect(await connection.db.select().from(agentUsagePeriods)).toHaveLength(1);

    const outageAt = new Date(READY_AT.getTime() + 62_000);
    await connection.db
      .update(agentRuntimeReconciliations)
      .set({ nextAttemptAt: outageAt })
      .where(eq(agentRuntimeReconciliations.agentId, AGENT_ID));
    const outageStatus = vi.fn(async () => ({
      ok: true,
      runner: runnerRecord(),
      snapshot: readySnapshot({ gateway: { state: "failed", observedAt: outageAt.toISOString() } }),
    }));

    await expect(
      reconcileTargetAgentRuntime(AGENT_ID, {
        createConnection: () => connection,
        now: () => outageAt,
        loadContext: vi.fn(async () => ({
          agentStatus: "running" as const,
          runner: runnerRecord(),
          runnerAvailability: "eligible" as const,
        })),
        manualRunnerAdapter: vi.fn(
          () =>
            ({
              status: outageStatus,
              start: vi.fn(),
              stop: vi.fn(),
            }) as unknown as RuntimeRunnerAdapter,
        ),
      }),
    ).resolves.toEqual({ processed: 1, outcome: "recovering" });

    const [runtimeAfterOutage] = await connection.db.select().from(agentRuntimeReconciliations);
    const [usage] = await connection.db.select().from(agentUsagePeriods);
    const events = await connection.db.select().from(agentEvents);
    const [deployment] = await connection.db.select().from(agentDeployments);
    expect(runtimeAfterOutage).toMatchObject({
      state: "recovering_stop",
      recoveryCount: 1,
      errorCode: "runtime_gateway_unhealthy",
      lastObservedAt: outageAt,
    });
    expect(usage).toMatchObject({
      startedAt: new Date(READY_AT.getTime() + 1_000),
      stoppedAt: outageAt,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "agent.runtime_recovery_requested",
      message: "Managed gateway recovery requested.",
      metadata: {
        fromStatus: "running",
        toStatus: "restarting",
        reasonCode: "runtime_gateway_unhealthy",
        recoveryCount: 1,
        desiredStatus: "running",
        cleanupRequired: false,
        telegramRequired: false,
      },
      createdAt: outageAt,
    });
    expect(deployment).toMatchObject({
      id: DEPLOYMENT_ID,
      stage: "ready",
      completedAt: READY_AT,
      runnerOperationId: OPERATION_ID,
    });

    const oldGenerationRecoveredAt = new Date(outageAt.getTime() + 1_000);
    const configBoundaryAt = new Date(outageAt.getTime() + 2_000);
    const recoveredAt = new Date(outageAt.getTime() + 3_000);
    await connection.db.insert(agentEvents).values([
      {
        agentId: AGENT_ID,
        actorUserId: USER_ID,
        type: "agent.runtime_recovered",
        message: "Managed gateway recovery completed.",
        metadata: {},
        createdAt: oldGenerationRecoveredAt,
      },
      {
        agentId: AGENT_ID,
        actorUserId: USER_ID,
        type: "config.updated",
        message: "Agent configuration updated.",
        metadata: {},
        createdAt: configBoundaryAt,
      },
    ]);
    await connection.db
      .update(agentRuntimeReconciliations)
      .set({
        state: "verifying",
        generation: (runtimeAfterOutage?.generation ?? 0) + 1,
        operationId: OPERATION_ID,
        attemptCount: 0,
        recoveryCount: 2,
        stableSince: null,
        errorCode: "runtime_gateway_unhealthy",
        nextAttemptAt: recoveredAt,
        updatedAt: configBoundaryAt,
      })
      .where(eq(agentRuntimeReconciliations.agentId, AGENT_ID));

    const recoveryDependencies = (at: Date): AgentRuntimeReconcilerDependencies => ({
      createConnection: () => connection,
      now: () => at,
      loadContext: vi.fn(async () => ({
        agentStatus: "restarting" as const,
        runner: runnerRecord(),
        runnerAvailability: "eligible" as const,
      })),
      manualRunnerAdapter: vi.fn(
        () =>
          ({
            status: vi.fn(async () => ({
              ok: true,
              runner: runnerRecord(),
              snapshot: readySnapshot(),
            })),
            start: vi.fn(),
            stop: vi.fn(),
          }) as unknown as RuntimeRunnerAdapter,
      ),
    });
    await reconcileTargetAgentRuntime(AGENT_ID, recoveryDependencies(recoveredAt));

    const [newGenerationRuntime] = await connection.db.select().from(agentRuntimeReconciliations);
    const duplicateAt = new Date(recoveredAt.getTime() + 1_000);
    await connection.db
      .update(agentRuntimeReconciliations)
      .set({
        state: "verifying",
        operationId: OPERATION_ID,
        stableSince: null,
        errorCode: "runtime_gateway_unhealthy",
        nextAttemptAt: duplicateAt,
        updatedAt: duplicateAt,
      })
      .where(eq(agentRuntimeReconciliations.agentId, AGENT_ID));
    await reconcileTargetAgentRuntime(AGENT_ID, recoveryDependencies(duplicateAt));

    const recoveredEvents = (await connection.db.select().from(agentEvents)).filter(
      (event) => event.type === "agent.runtime_recovered",
    );
    expect(newGenerationRuntime?.generation).toBe((runtimeAfterOutage?.generation ?? 0) + 1);
    expect(recoveredEvents).toHaveLength(2);
    expect(recoveredEvents.map((event) => event.createdAt).sort()).toEqual([
      oldGenerationRecoveredAt,
      recoveredAt,
    ]);
    expect(recoveredEvents[1]?.metadata).not.toHaveProperty("generation");

    const staleAt = new Date(duplicateAt.getTime() + 1_000);
    await connection.db
      .update(agentRuntimeReconciliations)
      .set({ nextAttemptAt: staleAt, updatedAt: staleAt })
      .where(eq(agentRuntimeReconciliations.agentId, AGENT_ID));
    const forbiddenStatus = vi.fn();
    await reconcileTargetAgentRuntime(AGENT_ID, {
      createConnection: () => connection,
      now: () => staleAt,
      loadContext: vi.fn(async () => ({
        agentStatus: "running" as const,
        runner: runnerRecord(),
        runnerAvailability: "unavailable" as const,
      })),
      manualRunnerAdapter: vi.fn(
        () =>
          ({
            status: forbiddenStatus,
            start: vi.fn(),
            stop: vi.fn(),
          }) as unknown as RuntimeRunnerAdapter,
      ),
    });
    expect(forbiddenStatus).not.toHaveBeenCalled();
    const usageAfterStale = await connection.db
      .select()
      .from(agentUsagePeriods)
      .orderBy(agentUsagePeriods.startedAt);
    expect(usageAfterStale.at(-1)).toMatchObject({
      startedAt: recoveredAt,
      stoppedAt: staleAt,
    });

    const adoptAt = new Date(staleAt.getTime() + 1_000);
    await connection.db
      .update(agentRuntimeReconciliations)
      .set({
        state: "observing",
        operationId: null,
        errorCode: null,
        nextAttemptAt: adoptAt,
        updatedAt: adoptAt,
      })
      .where(eq(agentRuntimeReconciliations.agentId, AGENT_ID));
    await reconcileTargetAgentRuntime(AGENT_ID, recoveryDependencies(adoptAt));
    const [adopted] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(adopted).toMatchObject({
      state: "observing",
      operationId: OPERATION_ID,
      lastReadyAt: adoptAt,
    });

    const driftAt = new Date(adoptAt.getTime() + 1_000);
    const differentOperationId = "00000000-0000-4000-8000-000000009599";
    await connection.db
      .update(agentRuntimeReconciliations)
      .set({ nextAttemptAt: driftAt, updatedAt: driftAt })
      .where(eq(agentRuntimeReconciliations.agentId, AGENT_ID));
    const driftSnapshot = readySnapshot();
    if (!driftSnapshot.operation) {
      throw new Error("Expected an operation in the strict runtime fixture.");
    }
    const driftOperation = driftSnapshot.operation;
    await reconcileTargetAgentRuntime(AGENT_ID, {
      ...recoveryDependencies(driftAt),
      manualRunnerAdapter: vi.fn(
        () =>
          ({
            status: vi.fn(async () => ({
              ok: true,
              runner: runnerRecord(),
              snapshot: readySnapshot({
                operation: { ...driftOperation, id: differentOperationId },
              }),
            })),
            start: vi.fn(),
            stop: vi.fn(),
          }) as unknown as RuntimeRunnerAdapter,
      ),
    });
    const [afterDrift] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(afterDrift).toMatchObject({
      state: "recovering_stop",
      operationId: null,
      errorCode: "runtime_revision_mismatch",
    });
  });
});

async function seedReadyRuntime(connection: DatabaseConnection): Promise<void> {
  await connection.db.insert(users).values({ id: USER_ID });
  await connection.db.insert(runners).values({
    id: RUNNER_ID,
    userId: USER_ID,
    name: "runtime db runner",
    kind: "manual_vps",
    endpointUrl: "http://127.0.0.1:3987",
    status: "online",
    createdAt: READY_AT,
    updatedAt: READY_AT,
  });
  await connection.db.insert(agents).values({
    id: AGENT_ID,
    userId: USER_ID,
    runnerId: RUNNER_ID,
    name: "runtime db agent",
    templateKey: "research_agent",
    status: "running",
    desiredStatus: "running",
    createdAt: READY_AT,
    updatedAt: READY_AT,
  });
  await connection.db.insert(agentDeployments).values({
    id: DEPLOYMENT_ID,
    agentId: AGENT_ID,
    userId: USER_ID,
    stage: "ready",
    configRevision: REVISION,
    idempotencyKey: "runtime-reconciler-db",
    runnerOperationId: OPERATION_ID,
    runnerAcceptedAt: READY_AT,
    canaryState: "passed",
    canaryAttemptedAt: READY_AT,
    canaryCompletedAt: READY_AT,
    completedAt: READY_AT,
    createdAt: READY_AT,
    updatedAt: READY_AT,
  });
  await expect(
    initializeAgentRuntimeAfterDeploymentReady({
      db: connection.db,
      deploymentId: DEPLOYMENT_ID,
      agentId: AGENT_ID,
      userId: USER_ID,
      configRevision: REVISION,
      operationId: OPERATION_ID,
      now: READY_AT,
    }),
  ).resolves.toEqual({ inserted: true });
}

function runnerRecord(): ManualRunnerRecord {
  return {
    id: RUNNER_ID,
    userId: USER_ID,
    name: "runtime db runner",
    kind: "manual_vps",
    endpointUrl: "http://127.0.0.1:3987",
    status: "online",
    createdAt: READY_AT.toISOString(),
    updatedAt: READY_AT.toISOString(),
    deletedAt: null,
  };
}

function readySnapshot(
  overrides: Partial<RunnerDurableStatusSnapshot> = {},
): RunnerDurableStatusSnapshot {
  return {
    phase: "ready",
    operation: {
      id: OPERATION_ID,
      action: "start",
      target: {
        image: DEFAULT_HERMES_WORKLOAD_IMAGE,
        launchSpecVersion: MANAGED_AGENT_LAUNCH_SPEC_VERSION,
        configRevision: REVISION,
      },
      acceptedAt: READY_AT.toISOString(),
    },
    container: {
      id: "private-container",
      name: "private-name",
      image: DEFAULT_HERMES_WORKLOAD_IMAGE,
      state: "running",
      startedAt: READY_AT.toISOString(),
      finishedAt: null,
      observedAt: READY_AT.toISOString(),
      restartPolicy: { name: "unless-stopped", maximumRetryCount: 0 },
      restartCount: 0,
    },
    revision: {
      state: "match",
      requested: REVISION,
      containerLabel: REVISION,
      projectionMarker: REVISION,
      observedAt: READY_AT.toISOString(),
    },
    gateway: { state: "running", observedAt: READY_AT.toISOString() },
    apiServer: { required: true, state: "connected", observedAt: READY_AT.toISOString() },
    telegram: { required: true, state: "connected", observedAt: READY_AT.toISOString() },
    readinessReason: null,
    observedAt: READY_AT.toISOString(),
    ...overrides,
  };
}

async function createDisposableDatabase(): Promise<{ databaseName: string; databaseUrl: string }> {
  const databaseName = `bruno_step9_reconciler_${process.pid}_${Date.now()}`.toLowerCase();
  const admin = postgres(adminDatabaseUrl(), { max: 1 });
  try {
    await admin.unsafe(`create database ${quoteIdentifier(databaseName)}`);
  } finally {
    await admin.end();
  }
  return { databaseName, databaseUrl: databaseUrlFor(databaseName) };
}

async function dropDisposableDatabase(databaseName: string): Promise<void> {
  const admin = postgres(adminDatabaseUrl(), { max: 1 });
  try {
    await admin.unsafe(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`);
  } finally {
    await admin.end();
  }
}

async function runDbMigrate(databaseUrl: string): Promise<void> {
  await execFileAsync("bun", ["run", "db:migrate"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 30_000,
  });
}

function validatedBaseUrl(): URL {
  const parsed = new URL(BASE_DATABASE_URL);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("Runtime reconciler tests require loopback PostgreSQL.");
  }
  return parsed;
}

function adminDatabaseUrl(): string {
  const url = validatedBaseUrl();
  url.pathname = "/postgres";
  return url.toString();
}

function databaseUrlFor(databaseName: string): string {
  const url = validatedBaseUrl();
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) {
    throw new Error("Disposable runtime reconciler database name is invalid.");
  }
  return `"${value}"`;
}
