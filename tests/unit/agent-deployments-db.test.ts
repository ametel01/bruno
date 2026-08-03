import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimNextAgentDeployment,
  createAgentDeploymentForUser,
  releaseAgentDeploymentLease,
  renewAgentDeploymentLease,
  transitionAgentDeploymentStage,
} from "@/src/server/agents/agent-deployments";
import { getAgentTemplateSnapshot } from "@/src/server/agents/templates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentDeployments, agents, users } from "@/src/server/db/schema";

const USER_A_ID = "00000000-0000-4000-8000-000000000d01";
const USER_B_ID = "00000000-0000-4000-8000-000000000d02";
const AGENT_A_ID = "00000000-0000-4000-8000-000000000d11";
const AGENT_B_ID = "00000000-0000-4000-8000-000000000d12";
const NOW = new Date("2026-08-03T04:00:00.000Z");
const LEASE_MS = 60_000;

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
          createAgentDeploymentForUser({
            db: first.db,
            userId: USER_A_ID,
            agentId: AGENT_A_ID,
            configRevision: "cfg-Same-1",
            idempotencyKey: "  CaseSensitive-Key  ",
            now: NOW,
          }),
        ),
        runAfterBarrier(barrier, () =>
          createAgentDeploymentForUser({
            db: second.db,
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

  it("allows different users to reuse keys but rejects different active keys for one agent", async () => {
    const reusedByA = await createAgentDeploymentForUser({
      db: connection.db,
      userId: USER_A_ID,
      agentId: AGENT_A_ID,
      configRevision: "cfg-owner-a",
      idempotencyKey: "shared-key",
      now: NOW,
    });
    const reusedByB = await createAgentDeploymentForUser({
      db: connection.db,
      userId: USER_B_ID,
      agentId: AGENT_B_ID,
      configRevision: "cfg-owner-b",
      idempotencyKey: "shared-key",
      now: NOW,
    });

    expect(reusedByA.ok).toBe(true);
    expect(reusedByB.ok).toBe(true);

    const competing = await createAgentDeploymentForUser({
      db: connection.db,
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
        .set({ stage: "ready", completedAt: new Date(NOW.getTime() + 1_000) })
        .where(eq(agentDeployments.id, reusedByA.deployment.id));
    }

    const later = await createAgentDeploymentForUser({
      db: connection.db,
      userId: USER_A_ID,
      agentId: AGENT_A_ID,
      configRevision: "cfg-owner-a-3",
      idempotencyKey: "later-key",
      now: NOW,
    });

    expect(later).toMatchObject({ ok: true, inserted: true });

    const oldKey = await createAgentDeploymentForUser({
      db: connection.db,
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
            leaseOwner: "worker-a",
            leaseDurationMs: LEASE_MS,
            now: NOW,
          }),
        ),
        runAfterBarrier(barrier, () =>
          claimNextAgentDeployment({
            db: second.db,
            leaseOwner: "worker-b",
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
      expect(row?.leaseOwner).toMatch(/^worker-[ab]$/);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("allows exactly one stale-owner takeover at exact lease expiry", async () => {
    await insertDeployment("expiry-key");
    const claimed = await claimNextAgentDeployment({
      db: connection.db,
      leaseOwner: "original-worker",
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
            leaseOwner: "takeover-a",
            leaseDurationMs: LEASE_MS,
            now: expiry,
          }),
        ),
        runAfterBarrier(barrier, () =>
          claimNextAgentDeployment({
            db: second.db,
            leaseOwner: "takeover-b",
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
      expect(row?.leaseOwner).toMatch(/^takeover-[ab]$/);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("requires matching unexpired owners for release and renewal and future retry times", async () => {
    const deployment = await insertDeployment("release-key");
    const claimed = await claimNextAgentDeployment({
      db: connection.db,
      leaseOwner: "release-owner",
      leaseDurationMs: LEASE_MS,
      now: NOW,
    });
    expect(claimed?.id).toBe(deployment.id);

    await expect(
      renewAgentDeploymentLease({
        db: connection.db,
        deploymentId: deployment.id,
        leaseOwner: "stale-owner",
        leaseDurationMs: LEASE_MS,
        now: new Date(NOW.getTime() + 1_000),
      }),
    ).resolves.toEqual({ ok: false, reason: "lease_not_held" });
    await expect(
      releaseAgentDeploymentLease({
        db: connection.db,
        deploymentId: deployment.id,
        leaseOwner: "release-owner",
        now: new Date(NOW.getTime() + 1_000),
        nextAttemptAt: NOW,
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_lease" });

    const renewed = await renewAgentDeploymentLease({
      db: connection.db,
      deploymentId: deployment.id,
      leaseOwner: "release-owner",
      leaseDurationMs: LEASE_MS,
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(renewed.ok).toBe(true);

    const released = await releaseAgentDeploymentLease({
      db: connection.db,
      deploymentId: deployment.id,
      leaseOwner: "release-owner",
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
  });

  it("uses compare-and-set transitions and keeps terminal deployments immutable", async () => {
    const deployment = await insertDeployment("transition-key");
    const claimed = await claimNextAgentDeployment({
      db: connection.db,
      leaseOwner: "transition-owner",
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
          transitionAgentDeploymentStage({
            db: first.db,
            deploymentId: deployment.id,
            leaseOwner: "transition-owner",
            expectedStage: "pending",
            nextStage: "provisioning_runner",
            now: new Date(NOW.getTime() + 1_000),
          }),
        ),
        runAfterBarrier(barrier, () =>
          transitionAgentDeploymentStage({
            db: second.db,
            deploymentId: deployment.id,
            leaseOwner: "transition-owner",
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

    const sameStageNoLease = await transitionAgentDeploymentStage({
      db: connection.db,
      deploymentId: deployment.id,
      leaseOwner: "transition-owner",
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
      transitionAgentDeploymentStage({
        db: connection.db,
        deploymentId: deployment.id,
        leaseOwner: "transition-owner",
        expectedStage: "failed",
        nextStage: "failed",
        now: new Date(NOW.getTime() + 4_000),
        errorCode: "runner_unavailable",
      }),
    ).resolves.toEqual({ ok: false, reason: "terminal_deployment" });
  });

  async function insertDeployment(idempotencyKey: string) {
    const result = await createAgentDeploymentForUser({
      db: connection.db,
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
