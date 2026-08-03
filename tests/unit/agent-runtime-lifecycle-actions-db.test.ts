import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteAgentForUser,
  reconcileDockerRunnerAgentForUser,
  recordUnexpectedLocalRunnerExitForUser,
  restartAgentForUser,
  startAgentForUser,
  stopAgentForUser,
} from "@/src/server/agents/lifecycle";
import { getAgentTemplateSnapshot } from "@/src/server/agents/templates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentDeployments,
  agentRuntimeReconciliations,
  agents,
  runners,
  users,
} from "@/src/server/db/schema";

const USER_ID = "00000000-0000-4000-8000-000000000921";
const AGENT_ID = "00000000-0000-4000-8000-000000000922";
const RUNNER_ID = "00000000-0000-4000-8000-000000000923";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000924";
const OPERATION_ID = "00000000-0000-4000-8000-000000000925";
const NOW = new Date("2026-08-03T13:00:00.000Z");

describe("managed runtime lifecycle actions", () => {
  let connection: DatabaseConnection;

  beforeAll(() => {
    connection = createDatabaseConnection();
  });

  beforeEach(async () => {
    await reset(connection);
  });

  afterAll(async () => {
    await reset(connection);
    await connection.close();
  });

  it("persists managed Start before scheduling and never calls the runner synchronously", async () => {
    await seedManagedAgent(connection, {
      status: "stopped",
      desiredStatus: "stopped",
      runtimeState: "stopped",
    });
    const scheduleRuntimeReconcile = vi.fn(() => {
      // Scheduling happens only after the transaction is visible.
    });
    const runnerStart = vi.fn();

    const result = await startAgentForUser(USER_ID, AGENT_ID, {
      createConnection: () => connection,
      now: () => NOW,
      runnerAdapter: { start: runnerStart } as never,
      scheduleRuntimeReconcile,
    });

    expect(result).toMatchObject({ ok: true, state: "accepted", agent: { status: "starting" } });
    expect(runnerStart).not.toHaveBeenCalled();
    expect(scheduleRuntimeReconcile).toHaveBeenCalledWith(AGENT_ID);
    const [agent] = await connection.db.select().from(agents);
    const [runtime] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(agent).toMatchObject({ desiredStatus: "running", status: "starting" });
    expect(runtime).toMatchObject({ state: "recovering_start", generation: 1, nextAttemptAt: NOW });
  });

  it("persists managed Restart and schedules convergence without runner Restart", async () => {
    await seedManagedAgent(connection);
    const scheduleRuntimeReconcile = vi.fn();
    const runnerRestart = vi.fn();

    const result = await restartAgentForUser(USER_ID, AGENT_ID, {
      createConnection: () => connection,
      now: () => NOW,
      runnerAdapter: { restart: runnerRestart } as never,
      scheduleRuntimeReconcile,
    });

    expect(result).toMatchObject({ ok: true, state: "accepted", agent: { status: "restarting" } });
    expect(runnerRestart).not.toHaveBeenCalled();
    expect(scheduleRuntimeReconcile).toHaveBeenCalledWith(AGENT_ID);
    const [runtime] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(runtime).toMatchObject({ state: "recovering_stop", generation: 1, nextAttemptAt: NOW });
  });

  it("keeps DB-first Stop intent and schedules cron recovery when runner acceptance fails", async () => {
    await seedManagedAgent(connection);
    const scheduleRuntimeReconcile = vi.fn();
    const runnerStop = vi.fn(async () => {
      const [agent] = await connection.db.select().from(agents);
      const [runtime] = await connection.db.select().from(agentRuntimeReconciliations);
      expect(agent).toMatchObject({ desiredStatus: "stopped", status: "restarting" });
      expect(runtime).toMatchObject({ state: "stopping", generation: 1, nextAttemptAt: NOW });
      return { ok: false as const, reason: "runner_unavailable" as const };
    });

    const result = await stopAgentForUser(USER_ID, AGENT_ID, {
      createConnection: () => connection,
      now: () => NOW,
      manualRunnerAdapter: () => ({ stop: runnerStop }) as never,
      scheduleRuntimeReconcile,
    });

    expect(result).toEqual({ ok: false, reason: "runner_stop_failed" });
    expect(runnerStop).toHaveBeenCalledOnce();
    expect(scheduleRuntimeReconcile).toHaveBeenCalledWith(AGENT_ID);
    const [agent] = await connection.db.select().from(agents);
    const [runtime] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(agent).toMatchObject({ desiredStatus: "stopped", status: "restarting" });
    expect(runtime).toMatchObject({ state: "stopping", generation: 1 });
  });

  it("persists owner Stop intent when a latest-ready runtime row is missing without backfilling it", async () => {
    await seedManagedAgent(connection);
    await connection.db.delete(agentRuntimeReconciliations);
    const scheduleRuntimeReconcile = vi.fn();
    const runnerStop = vi.fn(async () => {
      const [agent] = await connection.db.select().from(agents);
      const runtimeRows = await connection.db.select().from(agentRuntimeReconciliations);
      expect(agent).toMatchObject({ desiredStatus: "stopped", status: "restarting" });
      expect(runtimeRows).toEqual([]);
      return { ok: false as const, reason: "runner_unavailable" as const };
    });

    const result = await stopAgentForUser(USER_ID, AGENT_ID, {
      createConnection: () => connection,
      now: () => NOW,
      manualRunnerAdapter: () => ({ stop: runnerStop }) as never,
      scheduleRuntimeReconcile,
    });

    expect(result).toEqual({ ok: false, reason: "runner_stop_failed" });
    expect(runnerStop).toHaveBeenCalledOnce();
    expect(scheduleRuntimeReconcile).not.toHaveBeenCalled();
    const [agent] = await connection.db.select().from(agents);
    expect(agent).toMatchObject({ desiredStatus: "stopped", status: "restarting" });
    await expect(connection.db.select().from(agentRuntimeReconciliations)).resolves.toEqual([]);
  });

  it("never falls back to a local adapter when managed Stop has no eligible runner transport", async () => {
    await seedManagedAgent(connection, { runnerStatus: "offline" });
    const scheduleRuntimeReconcile = vi.fn();
    const localStop = vi.fn();
    const manualRunnerAdapter = vi.fn();

    const result = await stopAgentForUser(USER_ID, AGENT_ID, {
      createConnection: () => connection,
      now: () => NOW,
      runnerAdapter: { stop: localStop } as never,
      manualRunnerAdapter,
      scheduleRuntimeReconcile,
    });

    expect(result).toEqual({ ok: false, reason: "runner_stop_failed" });
    expect(localStop).not.toHaveBeenCalled();
    expect(manualRunnerAdapter).not.toHaveBeenCalled();
    expect(scheduleRuntimeReconcile).toHaveBeenCalledWith(AGENT_ID);
    const [agent] = await connection.db.select().from(agents);
    const [runtime] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(agent).toMatchObject({ desiredStatus: "stopped", status: "restarting" });
    expect(runtime).toMatchObject({ state: "stopping", generation: 1 });
  });

  it("keeps latest-ready runtime-managed agents controller-owned after legacy exit signals", async () => {
    await seedManagedAgent(connection);
    const [runtimeBefore] = await connection.db.select().from(agentRuntimeReconciliations);
    const dockerStatus = vi.fn();
    const unexpectedExit = {
      agentId: AGENT_ID,
      process: {
        id: "00000000-0000-4000-8000-000000000926",
        agentId: AGENT_ID,
        pid: 9126,
        commandMetadata: {},
        status: "failed" as const,
        startedAt: NOW.toISOString(),
        stoppedAt: NOW.toISOString(),
        exitCode: 7,
        signal: null,
        lastError: "legacy local exit",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
      exitCode: 7,
      signal: null,
    };

    await expect(
      recordUnexpectedLocalRunnerExitForUser(USER_ID, unexpectedExit, {
        createConnection: () => connection,
        now: () => NOW,
      }),
    ).resolves.toBe(false);
    await expect(
      reconcileDockerRunnerAgentForUser(USER_ID, AGENT_ID, {
        createConnection: () => connection,
        dockerRunnerAdapter: { status: dockerStatus } as never,
        now: () => NOW,
      }),
    ).resolves.toBe(false);

    expect(dockerStatus).not.toHaveBeenCalled();
    const [agent] = await connection.db.select().from(agents);
    const [runtimeAfter] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(agent).toMatchObject({ desiredStatus: "running", status: "running" });
    expect(runtimeAfter).toEqual(runtimeBefore);

    await connection.db.delete(agentRuntimeReconciliations);
    await expect(
      recordUnexpectedLocalRunnerExitForUser(USER_ID, unexpectedExit, {
        createConnection: () => connection,
        now: () => NOW,
      }),
    ).resolves.toBe(false);
    await expect(
      reconcileDockerRunnerAgentForUser(USER_ID, AGENT_ID, {
        createConnection: () => connection,
        dockerRunnerAdapter: { status: dockerStatus } as never,
        now: () => NOW,
      }),
    ).resolves.toBe(false);
    expect(dockerStatus).not.toHaveBeenCalled();
    const [managedUnavailableAgent] = await connection.db.select().from(agents);
    expect(managedUnavailableAgent).toMatchObject({ desiredStatus: "running", status: "running" });

    await connection.db.delete(agentDeployments);
    await expect(
      recordUnexpectedLocalRunnerExitForUser(USER_ID, unexpectedExit, {
        createConnection: () => connection,
        now: () => NOW,
      }),
    ).resolves.toBe(true);
    const [legacyAgent] = await connection.db.select().from(agents);
    expect(legacyAgent).toMatchObject({ desiredStatus: "running", status: "error" });
  });

  it("fences and tombstones managed Delete before either cleanup boundary", async () => {
    await seedManagedAgent(connection);
    const assertTombstone = async () => {
      const [agent] = await connection.db.select().from(agents);
      const [runtime] = await connection.db.select().from(agentRuntimeReconciliations);
      expect(agent).toMatchObject({ desiredStatus: "stopped", deletedAt: NOW });
      expect(runtime).toMatchObject({ state: "stopped", generation: 1, nextAttemptAt: null });
    };
    const dockerCleanup = vi.fn(async () => {
      await assertTombstone();
      return { ok: true as const, container: null };
    });
    const manualStop = vi.fn(async () => {
      await assertTombstone();
      return { ok: true as const, containers: [] };
    });

    const result = await deleteAgentForUser(USER_ID, AGENT_ID, {
      createConnection: () => connection,
      now: () => NOW,
      dockerRunnerAdapter: { cleanup: dockerCleanup },
      manualRunnerAdapter: (runner) =>
        ({
          stop: async () => ({ ...(await manualStop()), runner }),
        }) as never,
    });

    expect(result).toMatchObject({
      ok: true,
      agent: { id: AGENT_ID, deletedAt: NOW.toISOString() },
    });
    expect(dockerCleanup).toHaveBeenCalledOnce();
    expect(manualStop).toHaveBeenCalledOnce();
  });
});

async function seedManagedAgent(
  connection: DatabaseConnection,
  input: {
    status?: "running" | "stopped";
    desiredStatus?: "running" | "stopped";
    runtimeState?: "observing" | "stopped";
    runnerStatus?: string;
  } = {},
): Promise<void> {
  const status = input.status ?? "running";
  const desiredStatus = input.desiredStatus ?? "running";
  const runtimeState = input.runtimeState ?? "observing";
  await connection.db.insert(users).values({ id: USER_ID });
  await connection.db.insert(runners).values({
    id: RUNNER_ID,
    userId: USER_ID,
    name: "Lifecycle action runner",
    kind: "manual_vps",
    endpointUrl: "http://127.0.0.1:3045",
    status: input.runnerStatus ?? "online",
  });
  await connection.db.insert(agents).values({
    id: AGENT_ID,
    userId: USER_ID,
    runnerId: RUNNER_ID,
    name: "Lifecycle action agent",
    templateKey: "research_agent",
    templateSnapshotJson: getAgentTemplateSnapshot("research_agent"),
    status,
    desiredStatus,
  });
  await connection.db.insert(agentDeployments).values({
    id: DEPLOYMENT_ID,
    agentId: AGENT_ID,
    userId: USER_ID,
    stage: "ready",
    configRevision: "cfg-lifecycle-action-0",
    idempotencyKey: "Runtime-Lifecycle-Action-001",
    runnerOperationId: OPERATION_ID,
    runnerAcceptedAt: NOW,
    canaryState: "passed",
    canaryAttemptedAt: NOW,
    canaryCompletedAt: NOW,
    completedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await connection.db.insert(agentRuntimeReconciliations).values({
    agentId: AGENT_ID,
    userId: USER_ID,
    state: runtimeState,
    configRevision: "cfg-lifecycle-action-0",
    operationId: runtimeState === "observing" ? OPERATION_ID : null,
    lastObservedAt: runtimeState === "observing" ? NOW : null,
    lastReadyAt: runtimeState === "observing" ? NOW : null,
    nextAttemptAt: runtimeState === "observing" ? NOW : null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table agent_runtime_reconciliations, agent_deployments, agents, runners, users restart identity cascade",
  );
}
