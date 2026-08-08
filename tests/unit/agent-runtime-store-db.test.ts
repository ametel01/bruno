import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_RUNTIME_LEASE_MS,
  applyClaimedAgentRuntimeResult,
  claimNextAgentRuntimeReconciliation,
  initializeAgentRuntimeAfterDeploymentReady,
  invalidateAgentRuntimeLease,
} from "@/src/server/agents/agent-runtime-store";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentDeployments,
  agentRuntimeReconciliations,
  agents,
  runners,
  users,
} from "@/src/server/db/schema";

const execFileAsync = promisify(execFile);
const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://bruno:bruno@127.0.0.1:54329/bruno";
const USER_ID = "00000000-0000-4000-8000-000000008001";
const RUNNER_A_ID = "00000000-0000-4000-8000-000000008101";
const RUNNER_B_ID = "00000000-0000-4000-8000-000000008102";
const AGENT_A_ID = "00000000-0000-4000-8000-000000008201";
const AGENT_B_ID = "00000000-0000-4000-8000-000000008202";
const DEPLOYMENT_A_ID = "00000000-0000-4000-8000-000000008301";
const DEPLOYMENT_B_ID = "00000000-0000-4000-8000-000000008302";
const DEPLOYMENT_C_ID = "00000000-0000-4000-8000-000000008303";
const DEPLOYMENT_D_ID = "00000000-0000-4000-8000-000000008304";
const OPERATION_A_ID = "00000000-0000-4000-8000-000000008401";
const OPERATION_B_ID = "00000000-0000-4000-8000-000000008402";
const OPERATION_C_ID = "00000000-0000-4000-8000-000000008403";
const OPERATION_D_ID = "00000000-0000-4000-8000-000000008404";
const LEASE_A = "reconcile:11111111-1111-4111-8111-111111111111";
const LEASE_B = "reconcile:22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-03T08:00:00.000Z");

describe("agent runtime persistence fences", () => {
  let databaseName: string;
  let databaseUrl: string;
  let connection: DatabaseConnection;

  beforeAll(async () => {
    ({ databaseName, databaseUrl } = await createDisposableDatabase());
    await runDbMigrate(databaseUrl);
    connection = createDatabaseConnection(databaseUrl);
  });

  beforeEach(async () => {
    await resetFixture(connection);
    await seedOwners(connection);
  });

  afterAll(async () => {
    await connection?.close();
    if (databaseName) {
      await dropDisposableDatabase(databaseName);
    }
  });

  it("inserts final ready once and leaves a same-evidence duplicate unchanged", async () => {
    await seedReadyAgent(connection, "a");

    const first = await initializeReady(connection, "a");
    expect(first).toEqual({ inserted: true });
    const duplicateAt = new Date(NOW.getTime() + 5_000);
    await expect(
      initializeAgentRuntimeAfterDeploymentReady({
        db: connection.db,
        deploymentId: DEPLOYMENT_A_ID,
        agentId: AGENT_A_ID,
        userId: USER_ID,
        configRevision: "cfg-runtime-a",
        operationId: OPERATION_A_ID,
        now: duplicateAt,
      }),
    ).resolves.toEqual({ inserted: false });

    const [row] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(row).toMatchObject({
      configRevision: "cfg-runtime-a",
      operationId: OPERATION_A_ID,
      updatedAt: NOW,
      nextAttemptAt: NOW,
    });
  });

  it("initializes runtime from a ready deployment whose production canary was skipped", async () => {
    await seedReadyAgent(connection, "a");
    await connection.db
      .update(agentDeployments)
      .set({
        canaryState: "skipped",
        canaryAttemptedAt: null,
        canaryCompletedAt: null,
      })
      .where(eq(agentDeployments.id, DEPLOYMENT_A_ID));

    await expect(initializeReady(connection, "a")).resolves.toEqual({ inserted: true });

    const [runtime] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(runtime).toMatchObject({
      agentId: AGENT_A_ID,
      state: "observing",
      configRevision: "cfg-runtime-a",
      operationId: OPERATION_A_ID,
    });
  });

  it("refreshes distinct latest-ready evidence on a safe generation-zero row", async () => {
    await seedReadyAgent(connection, "a");
    await initializeReady(connection, "a");
    const laterReadyAt = new Date(NOW.getTime() + 10_000);
    await insertDeployment(connection, {
      agentId: AGENT_A_ID,
      deploymentId: DEPLOYMENT_B_ID,
      operationId: OPERATION_B_ID,
      configRevision: "cfg-later-ready",
      createdAt: laterReadyAt,
    });

    await expect(
      initializeAgentRuntimeAfterDeploymentReady({
        db: connection.db,
        deploymentId: DEPLOYMENT_B_ID,
        agentId: AGENT_A_ID,
        userId: USER_ID,
        configRevision: "cfg-later-ready",
        operationId: OPERATION_B_ID,
        now: laterReadyAt,
      }),
    ).resolves.toEqual({ inserted: false });

    const [row] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(row).toMatchObject({
      generation: 0,
      state: "observing",
      configRevision: "cfg-later-ready",
      operationId: OPERATION_B_ID,
      attemptCount: 0,
      recoveryCount: 0,
      stableSince: laterReadyAt,
      lastObservedAt: laterReadyAt,
      lastReadyAt: laterReadyAt,
      nextAttemptAt: laterReadyAt,
      updatedAt: laterReadyAt,
    });
  });

  it("does not refresh distinct ready evidence after generation advances", async () => {
    await seedReadyAgent(connection, "a");
    await initializeReady(connection, "a");

    await expect(
      invalidateAgentRuntimeLease({
        db: connection.db,
        agentId: AGENT_A_ID,
        userId: USER_ID,
        expectedGeneration: 0,
        now: new Date(NOW.getTime() + 1_000),
      }),
    ).resolves.toBe(1);
    const laterReadyAt = new Date(NOW.getTime() + 10_000);
    await insertDeployment(connection, {
      agentId: AGENT_A_ID,
      deploymentId: DEPLOYMENT_B_ID,
      operationId: OPERATION_B_ID,
      configRevision: "cfg-later-blocked",
      createdAt: laterReadyAt,
    });
    await expect(
      initializeAgentRuntimeAfterDeploymentReady({
        db: connection.db,
        deploymentId: DEPLOYMENT_B_ID,
        agentId: AGENT_A_ID,
        userId: USER_ID,
        configRevision: "cfg-later-blocked",
        operationId: OPERATION_B_ID,
        now: laterReadyAt,
      }),
    ).resolves.toEqual({ inserted: false });

    const [row] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(row).toMatchObject({
      agentId: AGENT_A_ID,
      generation: 1,
      state: "observing",
      configRevision: "cfg-runtime-a",
      operationId: OPERATION_A_ID,
      nextAttemptAt: null,
    });
  });

  it("does not refresh a leased or circuit-open generation-zero row", async () => {
    await seedReadyAgent(connection, "a");
    await seedReadyAgent(connection, "b");
    await initializeReady(connection, "a");
    await initializeReady(connection, "b");
    await claimRequired(connection, LEASE_A, NOW);
    const circuitAt = new Date(NOW.getTime() + 1_000);
    await connection.db
      .update(agentRuntimeReconciliations)
      .set({
        state: "circuit_open",
        operationId: null,
        stableSince: null,
        errorCode: "runtime_recovery_exhausted",
        nextAttemptAt: null,
        circuitOpenedAt: circuitAt,
        updatedAt: circuitAt,
      })
      .where(eq(agentRuntimeReconciliations.agentId, AGENT_B_ID));

    const laterReadyAt = new Date(NOW.getTime() + 10_000);
    await insertDeployment(connection, {
      agentId: AGENT_A_ID,
      deploymentId: DEPLOYMENT_C_ID,
      operationId: OPERATION_C_ID,
      configRevision: "cfg-leased-blocked",
      createdAt: laterReadyAt,
    });
    await insertDeployment(connection, {
      agentId: AGENT_B_ID,
      deploymentId: DEPLOYMENT_D_ID,
      operationId: OPERATION_D_ID,
      configRevision: "cfg-circuit-blocked",
      createdAt: laterReadyAt,
    });

    await expect(
      initializeAgentRuntimeAfterDeploymentReady({
        db: connection.db,
        deploymentId: DEPLOYMENT_C_ID,
        agentId: AGENT_A_ID,
        userId: USER_ID,
        configRevision: "cfg-leased-blocked",
        operationId: OPERATION_C_ID,
        now: laterReadyAt,
      }),
    ).resolves.toEqual({ inserted: false });
    await expect(
      initializeAgentRuntimeAfterDeploymentReady({
        db: connection.db,
        deploymentId: DEPLOYMENT_D_ID,
        agentId: AGENT_B_ID,
        userId: USER_ID,
        configRevision: "cfg-circuit-blocked",
        operationId: OPERATION_D_ID,
        now: laterReadyAt,
      }),
    ).resolves.toEqual({ inserted: false });

    const rows = await connection.db
      .select()
      .from(agentRuntimeReconciliations)
      .orderBy(agentRuntimeReconciliations.agentId);
    expect(rows).toEqual([
      expect.objectContaining({
        agentId: AGENT_A_ID,
        configRevision: "cfg-runtime-a",
        operationId: OPERATION_A_ID,
        leaseOwner: LEASE_A,
      }),
      expect.objectContaining({
        agentId: AGENT_B_ID,
        configRevision: "cfg-runtime-b",
        operationId: null,
        state: "circuit_open",
        errorCode: "runtime_recovery_exhausted",
      }),
    ]);
  });

  it("uses separate connections and SKIP LOCKED so one global row is claimed once", async () => {
    await seedReadyAgent(connection, "a");
    await initializeReady(connection, "a");
    const first = createDatabaseConnection(databaseUrl);
    const second = createDatabaseConnection(databaseUrl);
    const barrier = createBarrier(2);

    try {
      const [claimA, claimB] = await Promise.all([
        runAfterBarrier(barrier, () =>
          claimNextAgentRuntimeReconciliation({
            db: first.db,
            target: { kind: "global" },
            leaseOwner: LEASE_A,
            now: NOW,
          }),
        ),
        runAfterBarrier(barrier, () =>
          claimNextAgentRuntimeReconciliation({
            db: second.db,
            target: { kind: "global" },
            leaseOwner: LEASE_B,
            now: NOW,
          }),
        ),
      ]);

      const claims = [claimA, claimB].filter((claim) => claim !== null);
      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({
        agentId: AGENT_A_ID,
        userId: USER_ID,
        runnerId: RUNNER_A_ID,
        latestDeploymentId: DEPLOYMENT_A_ID,
        generation: 0,
        attemptCount: 1,
      });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("scopes runner and agent targets while still deriving ownership from the database", async () => {
    await seedReadyAgent(connection, "a");
    await seedReadyAgent(connection, "b");
    await initializeReady(connection, "a");
    await initializeReady(connection, "b");

    const runnerClaim = await claimNextAgentRuntimeReconciliation({
      db: connection.db,
      target: { kind: "runner", runnerId: RUNNER_B_ID },
      leaseOwner: LEASE_A,
      now: NOW,
    });
    expect(runnerClaim).toMatchObject({ agentId: AGENT_B_ID, runnerId: RUNNER_B_ID });

    const agentClaim = await claimNextAgentRuntimeReconciliation({
      db: connection.db,
      target: { kind: "agent", agentId: AGENT_A_ID },
      leaseOwner: LEASE_B,
      now: NOW,
    });
    expect(agentClaim).toMatchObject({ agentId: AGENT_A_ID, runnerId: RUNNER_A_ID });
  });

  it("allows exactly one takeover at lease expiry", async () => {
    await seedReadyAgent(connection, "a");
    await initializeReady(connection, "a");
    await claimNextAgentRuntimeReconciliation({
      db: connection.db,
      target: { kind: "global" },
      leaseOwner: LEASE_A,
      now: NOW,
    });
    const first = createDatabaseConnection(databaseUrl);
    const second = createDatabaseConnection(databaseUrl);
    const expiry = new Date(NOW.getTime() + AGENT_RUNTIME_LEASE_MS);
    const barrier = createBarrier(2);

    try {
      const [claimA, claimB] = await Promise.all([
        runAfterBarrier(barrier, () =>
          claimNextAgentRuntimeReconciliation({
            db: first.db,
            target: { kind: "global" },
            leaseOwner: LEASE_A,
            now: expiry,
          }),
        ),
        runAfterBarrier(barrier, () =>
          claimNextAgentRuntimeReconciliation({
            db: second.db,
            target: { kind: "global" },
            leaseOwner: LEASE_B,
            now: expiry,
          }),
        ),
      ]);
      const claims = [claimA, claimB].filter((claim) => claim !== null);
      expect(claims).toHaveLength(1);
      expect(claims[0]?.attemptCount).toBe(2);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("applies one guarded result and rejects stale desired-state, generation, and lease fences", async () => {
    await seedReadyAgent(connection, "a");
    await initializeReady(connection, "a");
    const claim = await claimRequired(connection, LEASE_A, NOW);

    await connection.db
      .update(agents)
      .set({ desiredStatus: "stopped" })
      .where(eq(agents.id, AGENT_A_ID));
    await expect(
      applyClaimedAgentRuntimeResult({
        db: connection.db,
        claim,
        expectedDesiredStatus: "running",
        now: new Date(NOW.getTime() + 1_000),
        mutation: {
          state: "observing",
          lastObservedAt: new Date(NOW.getTime() + 1_000),
          lastReadyAt: new Date(NOW.getTime() + 1_000),
          nextAttemptAt: new Date(NOW.getTime() + 61_000),
        },
      }),
    ).resolves.toBe(false);

    await connection.db
      .update(agents)
      .set({ desiredStatus: "running" })
      .where(eq(agents.id, AGENT_A_ID));
    await expect(
      invalidateAgentRuntimeLease({
        db: connection.db,
        agentId: AGENT_A_ID,
        userId: USER_ID,
        expectedGeneration: 0,
        now: new Date(NOW.getTime() + 2_000),
      }),
    ).resolves.toBe(1);
    await expect(
      applyClaimedAgentRuntimeResult({
        db: connection.db,
        claim,
        expectedDesiredStatus: "running",
        now: new Date(NOW.getTime() + 3_000),
        mutation: { state: "observing", nextAttemptAt: new Date(NOW.getTime() + 63_000) },
      }),
    ).resolves.toBe(false);

    const [row] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(row).toMatchObject({ generation: 1, attemptCount: 1, nextAttemptAt: null });
  });

  it("commits a matching result once and clears its lease", async () => {
    await seedReadyAgent(connection, "a");
    await initializeReady(connection, "a");
    const claim = await claimRequired(connection, LEASE_A, NOW);
    const observedAt = new Date(NOW.getTime() + 1_000);
    const nextAttemptAt = new Date(NOW.getTime() + 61_000);

    await expect(
      applyClaimedAgentRuntimeResult({
        db: connection.db,
        claim,
        expectedDesiredStatus: "running",
        now: observedAt,
        mutation: {
          state: "observing",
          attemptCount: 0,
          lastObservedAt: observedAt,
          lastReadyAt: observedAt,
          errorCode: null,
          nextAttemptAt,
        },
      }),
    ).resolves.toBe(true);
    await expect(
      applyClaimedAgentRuntimeResult({
        db: connection.db,
        claim,
        expectedDesiredStatus: "running",
        now: new Date(NOW.getTime() + 2_000),
        mutation: { state: "observing", nextAttemptAt },
      }),
    ).resolves.toBe(false);

    const [row] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(row).toMatchObject({
      state: "observing",
      attemptCount: 0,
      operationId: OPERATION_A_ID,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt,
      lastObservedAt: observedAt,
      lastReadyAt: observedAt,
    });
  });

  it("retains transient attempts across results and increments again on the next claim", async () => {
    await seedReadyAgent(connection, "a");
    await initializeReady(connection, "a");
    const firstClaim = await claimRequired(connection, LEASE_A, NOW);
    const firstResultAt = new Date(NOW.getTime() + 1_000);
    const retryAt = new Date(NOW.getTime() + 15_000);

    expect(firstClaim.attemptCount).toBe(1);
    await expect(
      applyClaimedAgentRuntimeResult({
        db: connection.db,
        claim: firstClaim,
        expectedDesiredStatus: "running",
        now: firstResultAt,
        mutation: {
          state: "observing",
          errorCode: "runtime_runner_unavailable",
          nextAttemptAt: retryAt,
        },
      }),
    ).resolves.toBe(true);

    const [afterRetry] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(afterRetry).toMatchObject({ attemptCount: 1, nextAttemptAt: retryAt });

    const secondClaim = await claimRequired(connection, LEASE_B, retryAt);
    expect(secondClaim.attemptCount).toBe(2);
  });

  it("increments generation atomically for desired stop while a concurrent generation wins", async () => {
    await seedReadyAgent(connection, "a");
    await seedReadyAgent(connection, "b");
    await initializeReady(connection, "a");
    await initializeReady(connection, "b");
    await connection.db
      .update(agents)
      .set({ desiredStatus: "stopped" })
      .where(sql`${agents.id} in (${AGENT_A_ID}, ${AGENT_B_ID})`);

    const claimA = await claimRequired(connection, LEASE_A, NOW);
    const claimB = await claimNextAgentRuntimeReconciliation({
      db: connection.db,
      target: { kind: "agent", agentId: AGENT_B_ID },
      leaseOwner: LEASE_B,
      now: NOW,
    });
    if (!claimB) {
      throw new Error("Expected second desired-stop runtime fixture claim.");
    }
    expect(claimA.desiredStatus).toBe("stopped");
    expect(claimB.desiredStatus).toBe("stopped");

    const transitionAt = new Date(NOW.getTime() + 1_000);
    await expect(
      applyClaimedAgentRuntimeResult({
        db: connection.db,
        claim: claimA,
        expectedDesiredStatus: "stopped",
        now: transitionAt,
        mutation: {
          state: "stopping",
          generation: claimA.generation + 2,
          nextAttemptAt: transitionAt,
        },
      }),
    ).rejects.toMatchObject({ name: "AgentRuntimePersistenceError" });
    await expect(
      applyClaimedAgentRuntimeResult({
        db: connection.db,
        claim: claimA,
        expectedDesiredStatus: "stopped",
        now: transitionAt,
        mutation: {
          state: "stopping",
          generation: claimA.generation + 1,
          errorCode: null,
          stableSince: null,
          telegramNonConnectedSince: null,
          nextAttemptAt: transitionAt,
          circuitOpenedAt: null,
        },
      }),
    ).resolves.toBe(true);

    await expect(
      invalidateAgentRuntimeLease({
        db: connection.db,
        agentId: AGENT_B_ID,
        userId: USER_ID,
        expectedGeneration: claimB.generation,
        now: transitionAt,
      }),
    ).resolves.toBe(claimB.generation + 1);
    await expect(
      applyClaimedAgentRuntimeResult({
        db: connection.db,
        claim: claimB,
        expectedDesiredStatus: "stopped",
        now: new Date(NOW.getTime() + 2_000),
        mutation: {
          state: "stopping",
          generation: claimB.generation + 1,
          nextAttemptAt: new Date(NOW.getTime() + 2_000),
        },
      }),
    ).resolves.toBe(false);

    const rows = await connection.db
      .select()
      .from(agentRuntimeReconciliations)
      .orderBy(agentRuntimeReconciliations.agentId);
    expect(rows).toEqual([
      expect.objectContaining({
        agentId: AGENT_A_ID,
        state: "stopping",
        generation: 1,
        operationId: null,
        leaseOwner: null,
      }),
      expect.objectContaining({
        agentId: AGENT_B_ID,
        state: "observing",
        generation: 1,
        operationId: OPERATION_B_ID,
        leaseOwner: null,
        nextAttemptAt: null,
      }),
    ]);
  });

  it("enforces operation, lease, stopped, circuit, and timestamp invariants in PostgreSQL", async () => {
    await seedReadyAgent(connection, "a");
    await initializeReady(connection, "a");

    await expect(
      connection.client`
        update agent_runtime_reconciliations
        set state = 'recovering_start'
        where agent_id = ${AGENT_A_ID}
      `,
    ).rejects.toMatchObject({
      constraint_name: "agent_runtime_reconciliations_operation_state_check",
    });
    await expect(
      connection.client`
        update agent_runtime_reconciliations
        set lease_owner = ${LEASE_A}
        where agent_id = ${AGENT_A_ID}
      `,
    ).rejects.toMatchObject({
      constraint_name: "agent_runtime_reconciliations_lease_pair_check",
    });
    await expect(
      connection.client`
        update agent_runtime_reconciliations
        set state = 'circuit_open', operation_id = null, next_attempt_at = null,
            error_code = null, circuit_opened_at = null
        where agent_id = ${AGENT_A_ID}
      `,
    ).rejects.toMatchObject({
      constraint_name: "agent_runtime_reconciliations_circuit_check",
    });
    await expect(
      connection.client`
        update agent_runtime_reconciliations
        set state = 'stopped', operation_id = null, error_code = 'runtime_internal_failure',
            next_attempt_at = null
        where agent_id = ${AGENT_A_ID}
      `,
    ).rejects.toMatchObject({
      constraint_name: "agent_runtime_reconciliations_stopped_check",
    });
    await expect(
      connection.client`
        update agent_runtime_reconciliations
        set last_observed_at = updated_at + interval '1 second'
        where agent_id = ${AGENT_A_ID}
      `,
    ).rejects.toMatchObject({
      constraint_name: "agent_runtime_reconciliations_observed_updated_check",
    });
  });

  it("rejects results after reassignment, deletion, newer deployment, or exact lease expiry", async () => {
    await seedReadyAgent(connection, "a");
    await initializeReady(connection, "a");

    for (const invalidation of ["runner", "deleted", "deployment", "expiry"] as const) {
      await connection.db
        .update(agentRuntimeReconciliations)
        .set({ leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: NOW, updatedAt: NOW })
        .where(eq(agentRuntimeReconciliations.agentId, AGENT_A_ID));
      await connection.db
        .update(agents)
        .set({ runnerId: RUNNER_A_ID, deletedAt: null })
        .where(eq(agents.id, AGENT_A_ID));
      await connection.db.delete(agentDeployments).where(eq(agentDeployments.id, DEPLOYMENT_B_ID));
      const claim = await claimRequired(connection, LEASE_A, NOW);
      let resultAt = new Date(NOW.getTime() + 1_000);

      if (invalidation === "runner") {
        await connection.db
          .update(agents)
          .set({ runnerId: RUNNER_B_ID })
          .where(eq(agents.id, AGENT_A_ID));
      } else if (invalidation === "deleted") {
        await connection.db
          .update(agents)
          .set({ deletedAt: resultAt })
          .where(eq(agents.id, AGENT_A_ID));
      } else if (invalidation === "deployment") {
        await insertDeployment(connection, {
          agentId: AGENT_A_ID,
          deploymentId: DEPLOYMENT_B_ID,
          operationId: OPERATION_B_ID,
          configRevision: "cfg-newer-ready",
          createdAt: resultAt,
        });
      } else {
        resultAt = new Date(NOW.getTime() + AGENT_RUNTIME_LEASE_MS);
      }

      await expect(
        applyClaimedAgentRuntimeResult({
          db: connection.db,
          claim,
          expectedDesiredStatus: "running",
          now: resultAt,
          mutation: { state: "observing", nextAttemptAt: new Date(resultAt.getTime() + 60_000) },
        }),
      ).resolves.toBe(false);
    }
  });
});

async function seedOwners(connection: DatabaseConnection): Promise<void> {
  await connection.db.insert(users).values({ id: USER_ID });
  await connection.db.insert(runners).values([
    {
      id: RUNNER_A_ID,
      userId: USER_ID,
      name: "runtime runner a",
      kind: "manual_vps",
      endpointUrl: "http://127.0.0.1:3045",
    },
    {
      id: RUNNER_B_ID,
      userId: USER_ID,
      name: "runtime runner b",
      kind: "manual_vps",
      endpointUrl: "http://127.0.0.1:3046",
    },
  ]);
}

async function seedReadyAgent(connection: DatabaseConnection, which: "a" | "b"): Promise<void> {
  const agentId = which === "a" ? AGENT_A_ID : AGENT_B_ID;
  const runnerId = which === "a" ? RUNNER_A_ID : RUNNER_B_ID;
  const deploymentId = which === "a" ? DEPLOYMENT_A_ID : DEPLOYMENT_B_ID;
  const operationId = which === "a" ? OPERATION_A_ID : OPERATION_B_ID;
  const configRevision = which === "a" ? "cfg-runtime-a" : "cfg-runtime-b";
  await connection.db.insert(agents).values({
    id: agentId,
    userId: USER_ID,
    runnerId,
    name: `runtime agent ${which}`,
    templateKey: "research_agent",
    status: "running",
    desiredStatus: "running",
  });
  await insertDeployment(connection, {
    agentId,
    deploymentId,
    operationId,
    configRevision,
    createdAt: NOW,
  });
}

async function insertDeployment(
  connection: DatabaseConnection,
  input: {
    agentId: string;
    deploymentId: string;
    operationId: string;
    configRevision: string;
    createdAt: Date;
  },
): Promise<void> {
  await connection.db.insert(agentDeployments).values({
    id: input.deploymentId,
    agentId: input.agentId,
    userId: USER_ID,
    stage: "ready",
    configRevision: input.configRevision,
    idempotencyKey: `runtime-${input.deploymentId.slice(-12)}`,
    runnerOperationId: input.operationId,
    runnerAcceptedAt: input.createdAt,
    canaryState: "passed",
    canaryAttemptedAt: input.createdAt,
    canaryCompletedAt: input.createdAt,
    completedAt: input.createdAt,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

async function initializeReady(
  connection: DatabaseConnection,
  which: "a" | "b",
): Promise<{ inserted: boolean }> {
  return initializeAgentRuntimeAfterDeploymentReady({
    db: connection.db,
    deploymentId: which === "a" ? DEPLOYMENT_A_ID : DEPLOYMENT_B_ID,
    agentId: which === "a" ? AGENT_A_ID : AGENT_B_ID,
    userId: USER_ID,
    configRevision: which === "a" ? "cfg-runtime-a" : "cfg-runtime-b",
    operationId: which === "a" ? OPERATION_A_ID : OPERATION_B_ID,
    now: NOW,
  });
}

async function claimRequired(connection: DatabaseConnection, leaseOwner: string, now: Date) {
  const claim = await claimNextAgentRuntimeReconciliation({
    db: connection.db,
    target: { kind: "agent", agentId: AGENT_A_ID },
    leaseOwner,
    now,
  });
  if (!claim) {
    throw new Error("Expected runtime fixture claim.");
  }
  return claim;
}

async function resetFixture(connection: DatabaseConnection): Promise<void> {
  await connection.db.execute(sql`
    truncate table agent_runtime_reconciliations, agent_events, agent_usage_periods,
      agent_deployments, agent_secrets, agent_configs, agent_approvals,
      agent_logs, docker_runner_containers, local_runner_processes,
      runner_heartbeats, runner_credentials, runner_registration_tokens,
      runner_provisioning_events, backups, agents, runners, users restart identity cascade
  `);
}

function createBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === parties) {
      release?.();
    }
    await ready;
  };
}

async function runAfterBarrier<T>(barrier: () => Promise<void>, run: () => Promise<T>): Promise<T> {
  await barrier();
  return run();
}

async function createDisposableDatabase(): Promise<{
  databaseName: string;
  databaseUrl: string;
}> {
  const databaseName = `bruno_step9_store_${process.pid}_${Date.now()}`.toLowerCase();
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
    throw new Error("Runtime store tests require loopback PostgreSQL.");
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
    throw new Error("Disposable runtime store database name is invalid.");
  }
  return `"${value}"`;
}
