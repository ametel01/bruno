import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentDeployments,
  agentEvents,
  agentRuntimeReconciliations,
  agentSecrets,
  agents,
  agentUsagePeriods,
  appMetadata,
  dockerRunnerContainers,
  runnerCredentials,
  runners,
  users,
} from "@/src/server/db/schema";
import {
  checkHermesStagingOwnerIsolation,
  HERMES_READY_DEPLOYMENT_STAGES,
  HERMES_STAGING_OWNER_METADATA_KEY,
  observeHermesAgentSecretCounts,
  observeHermesDeploymentStageHistory,
  observeHermesOpenUsagePeriod,
  observeHermesResourceAbsence,
  observeHermesRunnerCredentialCount,
  observeHermesStagingAcceptanceCorrelation,
  observeHermesStopStability,
  resolveHermesStagingOwner,
} from "@/src/server/staging/hermes-staging-product-observer";

const ROLLBACK = Symbol("rollback hermes staging product observer test");

describe.sequential("Hermes staging product observer", () => {
  let connection: DatabaseConnection;

  beforeAll(() => {
    connection = createDatabaseConnection();
  });

  afterAll(async () => {
    await connection.close();
  });

  it("creates and reuses only its dedicated null-Clerk staging owner", async () => {
    await inRollbackTransaction(connection, async (tx) => {
      await tx.delete(appMetadata).where(eq(appMetadata.key, HERMES_STAGING_OWNER_METADATA_KEY));

      const first = await resolveHermesStagingOwner(tx);
      expect(first).toMatchObject({ ok: true, created: true });
      if (!first.ok) throw new Error("Expected owner creation.");

      const [owner] = await tx
        .select({ clerkUserId: users.clerkUserId })
        .from(users)
        .where(eq(users.id, first.userId));
      expect(owner).toEqual({ clerkUserId: null });

      await expect(resolveHermesStagingOwner(tx)).resolves.toEqual({
        ok: true,
        userId: first.userId,
        created: false,
      });
      await expect(checkHermesStagingOwnerIsolation(tx, first.userId)).resolves.toEqual({
        isolated: true,
      });

      const [unrelatedSyntheticUser] = await tx
        .insert(users)
        .values({ clerkUserId: null })
        .returning({ id: users.id });
      if (!unrelatedSyntheticUser) throw new Error("Expected unrelated synthetic user.");
      await expect(
        checkHermesStagingOwnerIsolation(tx, unrelatedSyntheticUser.id),
      ).resolves.toEqual({ isolated: false, reason: "invalid_owner" });
    });
  });

  it("fails closed for a Clerk owner or a user shared with development mode", async () => {
    await inRollbackTransaction(connection, async (tx) => {
      const [clerkUser] = await tx
        .insert(users)
        .values({ clerkUserId: `user_${randomUUID()}` })
        .returning({ id: users.id });
      if (!clerkUser) throw new Error("Expected Clerk test user.");

      await tx
        .insert(appMetadata)
        .values({ key: HERMES_STAGING_OWNER_METADATA_KEY, value: clerkUser.id })
        .onConflictDoUpdate({
          target: appMetadata.key,
          set: { value: clerkUser.id },
        });
      await expect(resolveHermesStagingOwner(tx)).resolves.toEqual({
        ok: false,
        reason: "staging_owner_has_clerk_identity",
      });

      const [syntheticUser] = await tx
        .insert(users)
        .values({ clerkUserId: null })
        .returning({ id: users.id });
      if (!syntheticUser) throw new Error("Expected synthetic test user.");

      await tx
        .insert(appMetadata)
        .values([
          { key: HERMES_STAGING_OWNER_METADATA_KEY, value: syntheticUser.id },
          { key: "local_development_user_id", value: syntheticUser.id },
        ])
        .onConflictDoUpdate({
          target: appMetadata.key,
          set: { value: syntheticUser.id },
        });
      await expect(resolveHermesStagingOwner(tx)).resolves.toEqual({
        ok: false,
        reason: "staging_owner_shared_with_development",
      });
    });
  });

  it("validates exact ownership correlation and all seven ordered deployment checkpoints", async () => {
    await inRollbackTransaction(connection, async (tx) => {
      const fixture = await seedAcceptanceFixture(tx);

      await expect(observeHermesStagingAcceptanceCorrelation(tx, fixture)).resolves.toMatchObject({
        state: "matched",
        agentStatus: "running",
        desiredStatus: "running",
        deploymentStage: "ready",
        runnerStatus: "online",
        runnerKind: "manual_vps",
      });
      await expect(observeHermesDeploymentStageHistory(tx, fixture)).resolves.toEqual({
        state: "complete",
        lastStage: "ready",
        nextStage: null,
      });

      const foreignUserId = randomUUID();
      await expect(
        observeHermesStagingAcceptanceCorrelation(tx, {
          ...fixture,
          userId: foreignUserId,
        }),
      ).resolves.toEqual({ state: "agent_not_owned" });

      await tx
        .update(agentEvents)
        .set({
          metadata: { deploymentId: fixture.deploymentId, fromStage: "pending", toStage: "ready" },
        })
        .where(eq(agentEvents.type, "agent.deployment_stage_changed"));
      await expect(observeHermesDeploymentStageHistory(tx, fixture)).resolves.toEqual({
        state: "invalid",
      });
    });
  });

  it("returns closed Stop, secret, credential, usage, and absence observations", async () => {
    await inRollbackTransaction(connection, async (tx) => {
      const fixture = await seedAcceptanceFixture(tx);
      const now = new Date("2026-08-03T04:00:00.000Z");

      await tx
        .update(agents)
        .set({ status: "stopped", desiredStatus: "stopped", updatedAt: now })
        .where(eq(agents.id, fixture.agentId));
      await tx.insert(agentRuntimeReconciliations).values({
        agentId: fixture.agentId,
        userId: fixture.userId,
        state: "stopped",
        generation: 1,
        configRevision: "cfg-staging-observer",
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(agentUsagePeriods).values({
        agentId: fixture.agentId,
        runnerId: fixture.runnerId,
        startedAt: new Date("2026-08-03T03:00:00.000Z"),
        stoppedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      for (const [index, kind] of [
        "openrouter_api_key",
        "telegram_bot_token",
        "telegram_allowed_users",
        "api_server_key",
      ].entries()) {
        await tx.insert(agentSecrets).values({
          agentId: fixture.agentId,
          kind: kind as typeof agentSecrets.$inferInsert.kind,
          ciphertext: "ciphertext",
          iv: "iv",
          authTag: "auth-tag",
          keyVersion: "v1",
          fingerprint: `${index}`.repeat(16),
          status: "revoked",
          revokedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
      await tx.insert(runnerCredentials).values({
        runnerId: fixture.runnerId,
        credentialHash: "a".repeat(64),
        credentialPrefix: "agb_run_observe",
        status: "revoked",
        revokedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      await expect(observeHermesStopStability(tx, fixture)).resolves.toMatchObject({
        state: "observed",
        agentPresence: "active",
        desiredStatus: "stopped",
        currentStatus: "stopped",
        runtimeState: "stopped",
        stableStopped: true,
      });
      await expect(observeHermesAgentSecretCounts(tx, fixture)).resolves.toMatchObject({
        state: "observed",
        allRevoked: true,
        counts: {
          openrouter_api_key: { active: 0, revoked: 1 },
          telegram_bot_token: { active: 0, revoked: 1 },
          telegram_allowed_users: { active: 0, revoked: 1 },
          api_server_key: { active: 0, revoked: 1 },
        },
      });
      await expect(observeHermesRunnerCredentialCount(tx, fixture)).resolves.toEqual({
        state: "observed",
        activeCount: 0,
        allRevoked: true,
      });
      await expect(observeHermesOpenUsagePeriod(tx, fixture)).resolves.toEqual({
        state: "observed",
        openPeriod: "absent",
        openCount: 0,
      });

      await tx.insert(dockerRunnerContainers).values({
        agentId: fixture.agentId,
        containerId: `container-${randomUUID()}`,
        containerName: "staging-observer",
        image:
          "ghcr.io/example/hermes@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        observedStatus: "running",
        observedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await expect(observeHermesResourceAbsence(tx, fixture)).resolves.toMatchObject({
        state: "observed",
        workload: "recorded_present",
        agent: "active",
        runner: "active",
        allAbsent: false,
      });

      await tx
        .update(dockerRunnerContainers)
        .set({ finishedAt: now, observedStatus: "exited", updatedAt: now })
        .where(eq(dockerRunnerContainers.agentId, fixture.agentId));
      await tx.update(agents).set({ deletedAt: now }).where(eq(agents.id, fixture.agentId));
      await tx.update(runners).set({ deletedAt: now }).where(eq(runners.id, fixture.runnerId));
      await expect(observeHermesResourceAbsence(tx, fixture)).resolves.toEqual({
        state: "observed",
        workload: "recorded_absent",
        agent: "deleted",
        runner: "deleted",
        allAbsent: true,
      });
    });
  });

  it("rejects a non-isolated owner without exposing resource identifiers", async () => {
    await inRollbackTransaction(connection, async (tx) => {
      await tx.delete(appMetadata).where(eq(appMetadata.key, HERMES_STAGING_OWNER_METADATA_KEY));
      const owner = await resolveHermesStagingOwner(tx);
      if (!owner.ok) throw new Error("Expected owner creation.");

      const [agent] = await tx
        .insert(agents)
        .values({
          userId: owner.userId,
          name: "existing staging agent",
          templateKey: "research_agent",
        })
        .returning({ id: agents.id });
      if (!agent) throw new Error("Expected isolation test agent.");
      const result = await checkHermesStagingOwnerIsolation(tx, owner.userId);
      expect(result).toEqual({ isolated: false, reason: "active_agents_present" });
      expect(JSON.stringify(result)).not.toContain(owner.userId);

      const now = new Date("2026-08-03T05:00:00.000Z");
      await tx.update(agents).set({ deletedAt: now }).where(eq(agents.id, agent.id));
      await tx.insert(runners).values({
        userId: owner.userId,
        name: "existing staging runner",
        kind: "manual_vps",
        endpointUrl: "https://runner.invalid",
      });
      await expect(checkHermesStagingOwnerIsolation(tx, owner.userId)).resolves.toEqual({
        isolated: false,
        reason: "active_runners_present",
      });
    });
  });
});

type TestTransaction = Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0];

async function inRollbackTransaction(
  connection: DatabaseConnection,
  callback: (tx: TestTransaction) => Promise<void>,
): Promise<void> {
  try {
    await connection.db.transaction(async (tx) => {
      await callback(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

async function seedAcceptanceFixture(tx: TestTransaction): Promise<{
  userId: string;
  agentId: string;
  deploymentId: string;
  runnerId: string;
}> {
  const now = new Date("2026-08-03T01:00:00.000Z");
  const userId = randomUUID();
  const runnerId = randomUUID();
  const agentId = randomUUID();
  const deploymentId = randomUUID();

  await tx.insert(users).values({ id: userId, clerkUserId: null, createdAt: now, updatedAt: now });
  await tx.insert(runners).values({
    id: runnerId,
    userId,
    name: "staging-observer-runner",
    kind: "manual_vps",
    endpointUrl: "https://runner.invalid",
    status: "online",
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(agents).values({
    id: agentId,
    userId,
    runnerId,
    name: "staging-observer-agent",
    templateKey: "research_agent",
    status: "running",
    desiredStatus: "running",
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(agentDeployments).values({
    id: deploymentId,
    agentId,
    userId,
    stage: "ready",
    configRevision: "cfg-staging-observer",
    idempotencyKey: `staging-${randomUUID()}`,
    runnerOperationId: randomUUID(),
    runnerAcceptedAt: now,
    canaryState: "passed",
    canaryAttemptedAt: now,
    canaryCompletedAt: now,
    startedAt: now,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  await tx.insert(agentEvents).values({
    agentId,
    actorUserId: userId,
    type: "agent.created",
    message: "Created staging acceptance agent.",
    metadata: { deploymentId, launchMode: "ready" },
    createdAt: now,
  });
  for (let index = 1; index < HERMES_READY_DEPLOYMENT_STAGES.length; index += 1) {
    await tx.insert(agentEvents).values({
      agentId,
      actorUserId: userId,
      type: "agent.deployment_stage_changed",
      message: "Advanced staging acceptance deployment.",
      metadata: {
        deploymentId,
        fromStage: HERMES_READY_DEPLOYMENT_STAGES[index - 1],
        toStage: HERMES_READY_DEPLOYMENT_STAGES[index],
      },
      createdAt: new Date(now.getTime() + index * 1_000),
    });
  }

  return { userId, agentId, deploymentId, runnerId };
}
