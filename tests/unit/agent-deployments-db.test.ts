import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  quarantineAgentDeploymentForSafety,
  claimNextAgentDeployment,
  createAgentDeploymentForUser,
  releaseAgentDeploymentLease,
  renewAgentDeploymentLease,
  transitionAgentDeploymentStage,
} from "@/src/server/agents/agent-deployments";
import { captureAgentDeploymentChoicesFromEnvironment } from "@/src/server/agents/agent-deployment-choices";
import { getAgentTemplateSnapshot } from "@/src/server/agents/templates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentDeploymentWakeups, agentDeployments, agents, users } from "@/src/server/db/schema";

const USER_A_ID = "00000000-0000-4000-8000-000000000d01";
const USER_B_ID = "00000000-0000-4000-8000-000000000d02";
const AGENT_A_ID = "00000000-0000-4000-8000-000000000d11";
const AGENT_B_ID = "00000000-0000-4000-8000-000000000d12";
const NOW = new Date("2026-08-03T04:00:00.000Z");
const LEASE_MS = 60_000;
const LEASE_OWNER_A = "reconcile:11111111-1111-4111-8111-111111111111";
const LEASE_OWNER_B = "reconcile:22222222-2222-4222-8222-222222222222";
const LEASE_OWNER_C = "reconcile:33333333-3333-4333-8333-333333333333";

describe("agent deployment persistence and leases", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetDeploymentTables(connection);
    await seedDeploymentOwners(connection);
  });

  afterEach(async () => {
    await resetDeploymentTables(connection);
    await connection.close();
  });

  it("converges same owner/idempotency races to one deployment while preserving key case", async () => {
    const first = createDatabaseConnection();
    const second = createDatabaseConnection();
    const barrier = createBarrier(2);

    try {
      const [firstResult, secondResult] = await Promise.all([
        runAfterBarrier(barrier, () =>
          createDeploymentInTransaction(first, {
            userId: USER_A_ID,
            agentId: AGENT_A_ID,
            configRevision: "cfg-Same-1",
            idempotencyKey: "  CaseSensitive-Key  ",
            now: NOW,
          }),
        ),
        runAfterBarrier(barrier, () =>
          createDeploymentInTransaction(second, {
            userId: USER_A_ID,
            agentId: AGENT_A_ID,
            configRevision: "cfg-Same-1",
            idempotencyKey: "CaseSensitive-Key",
            now: NOW,
          }),
        ),
      ]);

      expect(firstResult.ok).toBe(true);
      expect(secondResult.ok).toBe(true);

      if (!firstResult.ok || !secondResult.ok) {
        throw new Error("Expected both idempotent create calls to resolve.");
      }

      expect(firstResult.deployment.id).toBe(secondResult.deployment.id);
      expect([firstResult.inserted, secondResult.inserted].sort()).toEqual([false, true]);

      const rows = await connection.db.select().from(agentDeployments);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userId: USER_A_ID,
        agentId: AGENT_A_ID,
        idempotencyKey: "CaseSensitive-Key",
      });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("captures the accepted boundary from the database clock and keeps it immutable", async () => {
    const result = await createDeploymentInTransaction(connection, {
      userId: USER_A_ID,
      agentId: AGENT_A_ID,
      configRevision: "cfg-durable-acceptance",
      idempotencyKey: "durable-acceptance",
      deploymentEnvironment: "production",
      now: NOW,
    });

    expect(result).toMatchObject({
      ok: true,
      inserted: true,
      deployment: {
        createdAt: NOW.toISOString(),
        acceptedAt: expect.any(String),
      },
    });
    if (!result.ok) throw new Error("Expected deployment creation to succeed.");
    expect(new Date(result.deployment.acceptedAt ?? Number.NaN).getTime()).toBeGreaterThan(
      NOW.getTime(),
    );
    const [measured] = await connection.db
      .select({
        origin: agentDeployments.origin,
        initialCohort: agentDeployments.initialCohort,
        deploymentEnvironment: agentDeployments.deploymentEnvironment,
        rolloutConfigurationGeneration: agentDeployments.rolloutConfigurationGeneration,
      })
      .from(agentDeployments)
      .where(eq(agentDeployments.id, result.deployment.id));
    expect(measured).toEqual({
      origin: "owner_request",
      initialCohort: "cold_deployment",
      deploymentEnvironment: "production",
      rolloutConfigurationGeneration: 1,
    });

    await expect(
      connection.db
        .update(agentDeployments)
        .set({ acceptedAt: new Date("2026-08-08T00:00:00.000Z") })
        .where(eq(agentDeployments.id, result.deployment.id)),
    ).rejects.toMatchObject({
      cause: { constraint_name: "agent_deployments_accepted_at_immutable_check" },
    });

    await expect(
      connection.db
        .update(agentDeployments)
        .set({ initialCohort: "same_owner_reuse" })
        .where(eq(agentDeployments.id, result.deployment.id)),
    ).rejects.toMatchObject({
      cause: { constraint_name: "agent_deployments_slo_identity_immutable_check" },
    });

    await expect(
      connection.db
        .update(agentDeployments)
        .set({ rolloutConfigurationGeneration: 2 })
        .where(eq(agentDeployments.id, result.deployment.id)),
    ).rejects.toMatchObject({
      cause: { constraint_name: "agent_deployments_slo_identity_immutable_check" },
    });

    await expect(
      connection.db.insert(agentDeployments).values({
        userId: USER_B_ID,
        agentId: AGENT_B_ID,
        configRevision: "cfg-missing-acceptance",
        idempotencyKey: "missing-acceptance",
        acceptedAt: null,
      }),
    ).rejects.toMatchObject({
      cause: { constraint_name: "agent_deployments_accepted_at_required_check" },
    });

    const [defaulted] = await connection.db
      .insert(agentDeployments)
      .values({
        userId: USER_B_ID,
        agentId: AGENT_B_ID,
        configRevision: "cfg-defaulted-acceptance",
        idempotencyKey: "defaulted-acceptance",
      })
      .returning({
        acceptedAt: agentDeployments.acceptedAt,
        origin: agentDeployments.origin,
        initialCohort: agentDeployments.initialCohort,
        deploymentEnvironment: agentDeployments.deploymentEnvironment,
        rolloutConfigurationGeneration: agentDeployments.rolloutConfigurationGeneration,
      });
    expect(defaulted?.acceptedAt).toBeInstanceOf(Date);
    expect(defaulted).toMatchObject({
      origin: "operator_trial",
      initialCohort: "unknown",
      deploymentEnvironment: "non_production",
      rolloutConfigurationGeneration: 1,
    });
  });

  it("allows different users to reuse keys but rejects different active keys for one agent", async () => {
    const reusedByA = await createDeploymentInTransaction(connection, {
      userId: USER_A_ID,
      agentId: AGENT_A_ID,
      configRevision: "cfg-owner-a",
      idempotencyKey: "shared-key",
      now: NOW,
    });
    const reusedByB = await createDeploymentInTransaction(connection, {
      userId: USER_B_ID,
      agentId: AGENT_B_ID,
      configRevision: "cfg-owner-b",
      idempotencyKey: "shared-key",
      now: NOW,
    });

    expect(reusedByA.ok).toBe(true);
    expect(reusedByB.ok).toBe(true);

    const competing = await createDeploymentInTransaction(connection, {
      userId: USER_A_ID,
      agentId: AGENT_A_ID,
      configRevision: "cfg-owner-a-2",
      idempotencyKey: "different-key",
      now: NOW,
    });

    expect(competing).toEqual({ ok: false, reason: "active_deployment_exists" });

    if (reusedByA.ok) {
      await connection.db
        .update(agentDeployments)
        .set({
          stage: "failed",
          failedAt: new Date(NOW.getTime() + 1_000),
          errorCode: "runner_unavailable",
        })
        .where(eq(agentDeployments.id, reusedByA.deployment.id));
    }

    const later = await createDeploymentInTransaction(connection, {
      userId: USER_A_ID,
      agentId: AGENT_A_ID,
      configRevision: "cfg-owner-a-3",
      idempotencyKey: "later-key",
      now: NOW,
    });

    expect(later).toMatchObject({ ok: true, inserted: true });

    const oldKey = await createDeploymentInTransaction(connection, {
      userId: USER_A_ID,
      agentId: AGENT_A_ID,
      configRevision: "cfg-owner-a-ignored",
      idempotencyKey: "shared-key",
      now: NOW,
    });

    expect(oldKey.ok && reusedByA.ok ? oldKey.deployment.id : null).toBe(
      reusedByA.ok ? reusedByA.deployment.id : null,
    );
  });

  it("uses separate connections so only one pre-expiry claim succeeds", async () => {
    await insertDeployment("claim-key");
    const first = createDatabaseConnection();
    const second = createDatabaseConnection();
    const barrier = createBarrier(2);

    try {
      const [firstClaim, secondClaim] = await Promise.all([
        runAfterBarrier(barrier, () =>
          claimNextAgentDeployment({
            db: first.db,
            leaseOwner: LEASE_OWNER_A,
            leaseDurationMs: LEASE_MS,
            now: NOW,
          }),
        ),
        runAfterBarrier(barrier, () =>
          claimNextAgentDeployment({
            db: second.db,
            leaseOwner: LEASE_OWNER_B,
            leaseDurationMs: LEASE_MS,
            now: NOW,
          }),
        ),
      ]);

      const claims = [firstClaim, secondClaim].filter((claim) => claim !== null);
      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({ attemptCount: 1, startedAt: NOW.toISOString() });

      const [row] = await connection.db.select().from(agentDeployments);
      expect(row?.attemptCount).toBe(1);
      expect([LEASE_OWNER_A, LEASE_OWNER_B]).toContain(row?.leaseOwner);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("allows exactly one stale-owner takeover at exact lease expiry", async () => {
    await insertDeployment("expiry-key");
    const claimed = await claimNextAgentDeployment({
      db: connection.db,
      leaseOwner: LEASE_OWNER_A,
      leaseDurationMs: LEASE_MS,
      now: NOW,
    });
    expect(claimed).not.toBeNull();

    const first = createDatabaseConnection();
    const second = createDatabaseConnection();
    const barrier = createBarrier(2);
    const expiry = new Date(NOW.getTime() + LEASE_MS);

    try {
      const [firstClaim, secondClaim] = await Promise.all([
        runAfterBarrier(barrier, () =>
          claimNextAgentDeployment({
            db: first.db,
            leaseOwner: LEASE_OWNER_B,
            leaseDurationMs: LEASE_MS,
            now: expiry,
          }),
        ),
        runAfterBarrier(barrier, () =>
          claimNextAgentDeployment({
            db: second.db,
            leaseOwner: LEASE_OWNER_C,
            leaseDurationMs: LEASE_MS,
            now: expiry,
          }),
        ),
      ]);

      const takeovers = [firstClaim, secondClaim].filter((claim) => claim !== null);
      expect(takeovers).toHaveLength(1);
      expect(takeovers[0]).toMatchObject({ attemptCount: 2 });

      const [row] = await connection.db.select().from(agentDeployments);
      expect(row?.attemptCount).toBe(2);
      expect([LEASE_OWNER_B, LEASE_OWNER_C]).toContain(row?.leaseOwner);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("requires matching unexpired owners for release and renewal and future retry times", async () => {
    const deployment = await insertDeployment("release-key");
    const claimed = await claimNextAgentDeployment({
      db: connection.db,
      leaseOwner: LEASE_OWNER_A,
      leaseDurationMs: LEASE_MS,
      now: NOW,
    });
    expect(claimed?.id).toBe(deployment.id);

    await expect(
      renewAgentDeploymentLease({
        db: connection.db,
        deploymentId: deployment.id,
        leaseOwner: LEASE_OWNER_B,
        leaseDurationMs: LEASE_MS,
        now: new Date(NOW.getTime() + 1_000),
      }),
    ).resolves.toEqual({ ok: false, reason: "lease_not_held" });
    await expect(
      releaseDeploymentInTransaction(connection, {
        deploymentId: deployment.id,
        leaseOwner: LEASE_OWNER_A,
        now: new Date(NOW.getTime() + 1_000),
        nextAttemptAt: NOW,
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_lease" });

    const renewed = await renewAgentDeploymentLease({
      db: connection.db,
      deploymentId: deployment.id,
      leaseOwner: LEASE_OWNER_A,
      leaseDurationMs: LEASE_MS,
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(renewed.ok).toBe(true);

    const released = await releaseDeploymentInTransaction(connection, {
      deploymentId: deployment.id,
      leaseOwner: LEASE_OWNER_A,
      now: new Date(NOW.getTime() + 2_000),
      nextAttemptAt: new Date(NOW.getTime() + 30_000),
    });
    expect(released).toMatchObject({
      ok: true,
      deployment: {
        nextAttemptAt: "2026-08-03T04:00:30.000Z",
      },
    });

    const [row] = await connection.db.select().from(agentDeployments);
    expect(row?.leaseOwner).toBeNull();
    expect(row?.leaseExpiresAt).toBeNull();

    const wakeups = await connection.db
      .select()
      .from(agentDeploymentWakeups)
      .where(eq(agentDeploymentWakeups.deploymentId, deployment.id))
      .orderBy(agentDeploymentWakeups.generation);
    expect(wakeups).toMatchObject([
      { generation: 1, state: "terminal", dueAt: NOW },
      { generation: 2, state: "pending", dueAt: new Date(NOW.getTime() + 30_000) },
    ]);
  });

  it("uses compare-and-set transitions and keeps terminal deployments immutable", async () => {
    const deployment = await insertDeployment("transition-key");
    const claimed = await claimNextAgentDeployment({
      db: connection.db,
      leaseOwner: LEASE_OWNER_A,
      leaseDurationMs: LEASE_MS,
      now: NOW,
    });
    expect(claimed?.id).toBe(deployment.id);

    const first = createDatabaseConnection();
    const second = createDatabaseConnection();
    const barrier = createBarrier(2);

    try {
      const [firstTransition, secondTransition] = await Promise.all([
        runAfterBarrier(barrier, () =>
          transitionDeploymentInTransaction(first, {
            deploymentId: deployment.id,
            leaseOwner: LEASE_OWNER_A,
            expectedStage: "pending",
            nextStage: "provisioning_runner",
            now: new Date(NOW.getTime() + 1_000),
          }),
        ),
        runAfterBarrier(barrier, () =>
          transitionDeploymentInTransaction(second, {
            deploymentId: deployment.id,
            leaseOwner: LEASE_OWNER_A,
            expectedStage: "pending",
            nextStage: "provisioning_runner",
            now: new Date(NOW.getTime() + 1_000),
          }),
        ),
      ]);

      expect([firstTransition.ok, secondTransition.ok].sort()).toEqual([false, true]);
      expect([firstTransition, secondTransition].find((result) => !result.ok)).toMatchObject({
        ok: false,
        reason: "stale_deployment",
      });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }

    const sameStageNoLease = await transitionDeploymentInTransaction(connection, {
      deploymentId: deployment.id,
      leaseOwner: LEASE_OWNER_A,
      expectedStage: "provisioning_runner",
      nextStage: "provisioning_runner",
      now: new Date(NOW.getTime() + 2_000),
    });
    expect(sameStageNoLease).toEqual({ ok: false, reason: "lease_not_held" });

    await connection.db
      .update(agentDeployments)
      .set({
        stage: "failed",
        errorCode: "runner_unavailable",
        failedAt: new Date(NOW.getTime() + 3_000),
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(eq(agentDeployments.id, deployment.id));

    await expect(
      transitionDeploymentInTransaction(connection, {
        deploymentId: deployment.id,
        leaseOwner: LEASE_OWNER_A,
        expectedStage: "failed",
        nextStage: "failed",
        now: new Date(NOW.getTime() + 4_000),
        errorCode: "runner_unavailable",
      }),
    ).resolves.toEqual({ ok: false, reason: "terminal_deployment" });
  });

  it("creates generation-fenced wakeups atomically with create and terminal transitions", async () => {
    const deployment = await insertDeployment("wakeup-key");
    const initialWakeups = await connection.db
      .select()
      .from(agentDeploymentWakeups)
      .where(eq(agentDeploymentWakeups.deploymentId, deployment.id));
    expect(initialWakeups).toMatchObject([{ generation: 1, state: "pending", dueAt: NOW }]);

    const claimed = await claimNextAgentDeployment({
      db: connection.db,
      leaseOwner: LEASE_OWNER_A,
      leaseDurationMs: LEASE_MS,
      now: NOW,
    });
    expect(claimed?.id).toBe(deployment.id);

    await expect(
      transitionDeploymentInTransaction(connection, {
        deploymentId: deployment.id,
        leaseOwner: LEASE_OWNER_A,
        expectedStage: "pending",
        nextStage: "failed",
        now: new Date(NOW.getTime() + 1_000),
        errorCode: "runner_unavailable",
      }),
    ).resolves.toMatchObject({ ok: true });

    const terminalWakeups = await connection.db
      .select()
      .from(agentDeploymentWakeups)
      .where(eq(agentDeploymentWakeups.deploymentId, deployment.id));
    expect(terminalWakeups).toMatchObject([{ generation: 1, state: "terminal" }]);
  });

  it("rejects plain database handles before exposing half of a deployment and wakeup mutation", async () => {
    await expect(
      createAgentDeploymentForUser({
        db: connection.db as never,
        userId: USER_A_ID,
        agentId: AGENT_A_ID,
        configRevision: "cfg-plain-db-rejected",
        idempotencyKey: "plain-db-rejected",
        now: NOW,
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: "Deployment wakeup writes require an owning transaction.",
      }),
    });

    await expect(connection.db.select().from(agentDeployments)).resolves.toEqual([]);
    await expect(connection.db.select().from(agentDeploymentWakeups)).resolves.toEqual([]);
  });

  it("retains accepted choices through explicit safety quarantine without rewriting evidence", async () => {
    const choices = {
      ...captureAgentDeploymentChoicesFromEnvironment({}, 1),
      dispatchMode: "qstash" as const,
    };
    const created = await createDeploymentInTransaction(connection, {
      userId: USER_A_ID,
      agentId: AGENT_A_ID,
      configRevision: "cfg-pinned-choices",
      idempotencyKey: "pinned-choices",
      deploymentChoices: choices,
      now: NOW,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await expect(
      connection.db.transaction((tx) =>
        quarantineAgentDeploymentForSafety({
          db: tx,
          userId: USER_A_ID,
          deploymentId: created.deployment.id,
          reason: "artifact identity mismatch",
          now: new Date(NOW.getTime() + 1_000),
        }),
      ),
    ).resolves.toBe(true);

    const [row] = await connection.db
      .select()
      .from(agentDeployments)
      .where(eq(agentDeployments.id, created.deployment.id));
    expect(row).toMatchObject({
      stage: "failed",
      errorCode: "safety_quarantined",
      safetyQuarantineReason: "artifact identity mismatch",
      deploymentChoices: choices,
    });
    const [wakeup] = await connection.db
      .select({ state: agentDeploymentWakeups.state })
      .from(agentDeploymentWakeups)
      .where(eq(agentDeploymentWakeups.deploymentId, created.deployment.id));
    expect(wakeup).toEqual({ state: "terminal" });
    await expect(
      connection.client`update agent_deployments set deployment_choices = jsonb_set(deployment_choices, '{dispatchMode}', '"cron"'::jsonb) where id = ${created.deployment.id}`,
    ).rejects.toThrow("immutable");
  });

  async function insertDeployment(idempotencyKey: string) {
    const result = await createDeploymentInTransaction(connection, {
      userId: USER_A_ID,
      agentId: AGENT_A_ID,
      configRevision: `cfg-${idempotencyKey}`,
      idempotencyKey,
      now: NOW,
    });

    if (!result.ok) {
      throw new Error(`Deployment insert failed: ${result.reason}`);
    }

    return result.deployment;
  }
});

async function seedDeploymentOwners(connection: DatabaseConnection): Promise<void> {
  await connection.db.insert(users).values([{ id: USER_A_ID }, { id: USER_B_ID }]);
  await connection.db.insert(agents).values([
    {
      id: AGENT_A_ID,
      userId: USER_A_ID,
      name: "Deployment A",
      templateKey: "research_agent",
      templateSnapshotJson: getAgentTemplateSnapshot("research_agent"),
    },
    {
      id: AGENT_B_ID,
      userId: USER_B_ID,
      name: "Deployment B",
      templateKey: "research_agent",
      templateSnapshotJson: getAgentTemplateSnapshot("research_agent"),
    },
  ]);
}

async function resetDeploymentTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_deployments, agents, users restart identity cascade`;
}

function createDeploymentInTransaction(
  connection: DatabaseConnection,
  input: Omit<Parameters<typeof createAgentDeploymentForUser>[0], "db">,
) {
  return connection.db.transaction((tx) => createAgentDeploymentForUser({ db: tx, ...input }));
}

function releaseDeploymentInTransaction(
  connection: DatabaseConnection,
  input: Omit<Parameters<typeof releaseAgentDeploymentLease>[0], "db">,
) {
  return connection.db.transaction((tx) => releaseAgentDeploymentLease({ db: tx, ...input }));
}

function transitionDeploymentInTransaction(
  connection: DatabaseConnection,
  input: Omit<Parameters<typeof transitionAgentDeploymentStage>[0], "db">,
) {
  return connection.db.transaction((tx) => transitionAgentDeploymentStage({ db: tx, ...input }));
}

function createBarrier(parties: number): () => Promise<void> {
  let waiting = 0;
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return async () => {
    waiting += 1;

    if (waiting === parties) {
      release();
    }

    await promise;
  };
}

async function runAfterBarrier<T>(barrier: () => Promise<void>, operation: () => Promise<T>) {
  await barrier();
  return await operation();
}
