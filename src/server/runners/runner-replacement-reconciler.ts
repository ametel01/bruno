import "server-only";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { RUNNER_BOOT_CONTRACT_VERSION } from "@/src/runner-service/constants";
import { parseImmutableRunnerImageReference } from "@/src/runner-service/release-identity";
import {
  createAgentDeploymentForRunnerReplacement,
  retryAgentDeploymentForUser,
} from "@/src/server/agents/agent-deployment-retry";
import { scheduleAgentDeploymentReconcileAfterResponse } from "@/src/server/agents/agent-deployment-triggers";
import { scheduleAgentRuntimeReconcileAfterResponse } from "@/src/server/agents/agent-runtime-triggers";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentDeployments,
  agentEvents,
  agentRuntimeReconciliations,
  agents,
  agentUsagePeriods,
  runnerCredentials,
  runnerHeartbeats,
  runnerProvisioningEvents,
  runnerRegistrationTokens,
  runnerReplacements,
  runners,
} from "@/src/server/db/schema";
import { type DigitalOceanProviderConfig, readDigitalOceanProviderConfig } from "@/src/server/env";
import {
  DIGITALOCEAN_PROVIDER,
  type DigitalOceanOwnedSetProvider,
  type DigitalOceanProvider,
  type DigitalOceanProviderRequestContext,
} from "@/src/server/runners/digitalocean-provider";
import { ManualRunnerAdapter } from "@/src/server/runners/manual-runner-adapter";
import type { ManualRunnerRecord } from "@/src/server/runners/manual-runner-persistence";
import {
  type RunnerCompatibilityRequirement,
  requiredRunnerImageDigestForProvider,
} from "@/src/server/runners/runner-compatibility";
import {
  confirmCloudRunnerReadiness,
  RUNNER_HEARTBEAT_STALE_THRESHOLD_MS,
} from "@/src/server/runners/runner-heartbeat";
import { lockRunnerPlacementCapacityInTransaction } from "@/src/server/runners/runner-placement";
import {
  advanceAutomaticDigitalOceanRunnerProvisioning,
  createConfiguredDigitalOceanProvider,
  digitalOceanRunnerFirewallName,
} from "@/src/server/runners/runner-provisioning";
import type { RunnerReplacementReason } from "@/src/server/runners/runner-replacement-state";
import {
  applyClaimedRunnerReplacementTransition,
  type ClaimedRunnerReplacement,
  claimNextRunnerReplacement,
  reserveClaimedRunnerReplacementBudget,
} from "@/src/server/runners/runner-replacement-store";

const DEFAULT_RETRY_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
const REPLACEMENT_ACTIVE_STATES = new Set([
  "pending",
  "provisioning_target",
  "validating_target",
  "fencing_source",
  "reassigning",
  "converging_agents",
  "cleaning_source",
]);

export type RunnerReplacementReconcileResult =
  | { outcome: "idle" }
  | {
      outcome: "advanced" | "retry_scheduled" | "failed";
      replacementId: string;
      state: string;
    };

export type RunnerReplacementReconcilerDependencies = {
  confirmReadiness?: typeof confirmCloudRunnerReadiness;
  createConnection?: () => DatabaseConnection;
  maxAttempts?: number;
  now?: () => Date;
  provider?: DigitalOceanProvider;
  providerTimeoutMs?: number;
  readConfig?: () => DigitalOceanProviderConfig | null;
  retryDeployment?: typeof retryAgentDeploymentForUser;
  retryMs?: number;
  stopSourceAgent?: (source: ManualRunnerRecord, agentId: string) => Promise<unknown>;
  triggerDeployment?: (deploymentId: string) => void;
  triggerRuntime?: (agentId: string) => void;
};

export async function reconcileNextRunnerReplacement(input: {
  leaseOwner: string;
  replacementId?: string;
  dependencies?: RunnerReplacementReconcilerDependencies;
}): Promise<RunnerReplacementReconcileResult> {
  const dependencies = input.dependencies ?? {};
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const claimedAt = now();

  try {
    const claim = await claimNextRunnerReplacement({
      db: connection.db,
      target: input.replacementId
        ? { kind: "replacement", replacementId: input.replacementId }
        : { kind: "global" },
      leaseOwner: input.leaseOwner,
      now: claimedAt,
    });
    if (!claim) return { outcome: "idle" };
    if (!REPLACEMENT_ACTIVE_STATES.has(claim.state)) {
      return await scheduleRetry(connection, claim, claimedAt, dependencies.retryMs);
    }

    let config: DigitalOceanProviderConfig | null;
    try {
      config = dependencies.readConfig?.() ?? readDigitalOceanProviderConfig();
    } catch {
      return await failClaim(connection, claim, claimedAt, "target_provisioning_failed");
    }
    if (!config || !isReplacementConfigUsable(config)) {
      return await failClaim(connection, claim, claimedAt, "target_provisioning_failed");
    }

    if (claim.state === "pending") {
      return await initializeTarget(connection, claim, config, claimedAt);
    }

    const provider = dependencies.provider ?? createConfiguredDigitalOceanProvider(config);
    const deadline = providerDeadline(dependencies.providerTimeoutMs);
    try {
      if (claim.state === "provisioning_target") {
        return await reconcileProvisioningTarget({
          connection,
          claim,
          config,
          provider,
          context: deadline.context,
          dependencies,
          now: claimedAt,
        });
      }

      if (claim.state === "validating_target") {
        return await reconcileValidatingTarget({
          connection,
          claim,
          config,
          provider,
          context: deadline.context,
          dependencies,
          now: claimedAt,
        });
      }

      if (claim.state === "fencing_source") {
        return await reconcileFencingSource({
          connection,
          claim,
          context: deadline.context,
          dependencies,
          now: claimedAt,
        });
      }

      if (claim.state === "reassigning") {
        return await reconcileReassigning({
          connection,
          claim,
          config,
          dependencies,
          now: claimedAt,
        });
      }

      if (claim.state === "converging_agents") {
        return await reconcileConvergingAgents({
          connection,
          claim,
          dependencies,
          now: claimedAt,
        });
      }

      if (claim.state === "cleaning_source") {
        return await reconcileCleaningSource({
          connection,
          claim,
          provider,
          context: deadline.context,
          dependencies,
          now: claimedAt,
        });
      }

      return await scheduleRetry(connection, claim, claimedAt, dependencies.retryMs);
    } finally {
      deadline.clear();
    }
  } finally {
    if (ownsConnection) await connection.close();
  }
}

async function initializeTarget(
  connection: DatabaseConnection,
  claim: ClaimedRunnerReplacement,
  config: DigitalOceanProviderConfig,
  now: Date,
): Promise<RunnerReplacementReconcileResult> {
  const provisioningOperationKey = provisioningOperationKeyFor(claim.operationKey);
  return await connection.db.transaction(async (tx) => {
    const [source] = await tx
      .select({
        userId: runners.userId,
        name: runners.name,
        status: runners.status,
        provisioningStatus: runners.provisioningStatus,
        compatibilityState: runners.compatibilityState,
      })
      .from(runners)
      .where(
        and(
          eq(runners.id, claim.sourceRunnerId),
          eq(runners.kind, "digitalocean"),
          eq(runners.provider, DIGITALOCEAN_PROVIDER),
          isNull(runners.deletedAt),
        ),
      )
      .limit(1)
      .for("update");
    if (!source) throw new Error("Replacement source is unavailable.");
    if (
      claim.triggerDeploymentId === null &&
      !isInfrastructureReplacementSourceEligible(source, claim.reason)
    ) {
      const failed = await applyClaimedRunnerReplacementTransition({
        db: tx,
        claim,
        action: { kind: "fail", code: "state_invalid" },
        now,
      });
      if (!failed) throw new Error("Ineligible replacement source lost its claim fence.");
      return { outcome: "failed", replacementId: claim.id, state: "failed" };
    }

    const [target] = await tx
      .insert(runners)
      .values({
        userId: source.userId,
        name: `${source.name} replacement`,
        kind: "digitalocean",
        status: "provisioning",
        provider: DIGITALOCEAN_PROVIDER,
        region: config.region,
        sizeSlug: config.sizeSlug,
        image: config.image,
        provisioningStatus: "pending",
        provisioningOperationKey,
        provisioningStartedAt: now,
        requiredRunnerImageDigest: requiredRunnerImageDigestForProvider(config),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: runners.id });
    if (!target) throw new Error("Replacement target insert returned no row.");

    const advanced = await applyClaimedRunnerReplacementTransition({
      db: tx,
      claim,
      action: { kind: "advance", targetRunnerId: target.id },
      now,
    });
    if (!advanced) throw new Error("Replacement target association lost its claim fence.");
    return { outcome: "advanced", replacementId: claim.id, state: "provisioning_target" };
  });
}

async function reconcileProvisioningTarget(input: {
  connection: DatabaseConnection;
  claim: ClaimedRunnerReplacement;
  config: DigitalOceanProviderConfig;
  provider: DigitalOceanProvider;
  context: DigitalOceanProviderRequestContext;
  dependencies: RunnerReplacementReconcilerDependencies;
  now: Date;
}): Promise<RunnerReplacementReconcileResult> {
  const target = await readTarget(input.connection, input.claim);
  if (!target) return await failClaim(input.connection, input.claim, input.now, "state_invalid");
  const operationKey = target.provisioningOperationKey;
  if (!operationKey)
    return await failClaim(input.connection, input.claim, input.now, "state_invalid");

  if (target.provisioningStatus === "failed" || target.provisioningStatus === "cleaning_up") {
    return await cleanupFailedTarget({ ...input, terminalCode: "target_provisioning_failed" });
  }

  if (input.claim.triggerDeploymentId && input.claim.replacementCount === 0) {
    const budget = await reserveClaimedRunnerReplacementBudget({
      connection: input.connection,
      claim: input.claim,
      now: input.now,
    });
    if (!budget.reserved) {
      return { outcome: "failed", replacementId: input.claim.id, state: "failed" };
    }
  }

  const result = await advanceAutomaticDigitalOceanRunnerProvisioning({
    connection: input.connection,
    userId: target.userId,
    runnerId: target.id,
    operationKey,
    attemptCount: input.claim.attemptCount,
    maxAttempts: input.dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    config: input.config,
    provider: input.provider,
    context: input.context,
    now: () => input.now,
  });
  const refreshed = await readTarget(input.connection, input.claim);
  if (!result.ok || refreshed?.provisioningStatus === "failed") {
    return await cleanupFailedTarget({
      ...input,
      terminalCode: "target_provisioning_failed",
    });
  }
  if (
    refreshed?.provisioningStatus === "waiting_for_runner" ||
    refreshed?.provisioningStatus === "ready"
  ) {
    const advanced = await applyClaimedRunnerReplacementTransition({
      db: input.connection.db,
      claim: input.claim,
      action: { kind: "advance" },
      now: input.now,
    });
    return advanced
      ? { outcome: "advanced", replacementId: input.claim.id, state: "validating_target" }
      : { outcome: "retry_scheduled", replacementId: input.claim.id, state: input.claim.state };
  }
  return await scheduleRetry(input.connection, input.claim, input.now, input.dependencies.retryMs);
}

async function reconcileValidatingTarget(input: {
  connection: DatabaseConnection;
  claim: ClaimedRunnerReplacement;
  config: DigitalOceanProviderConfig;
  provider: DigitalOceanProvider;
  context: DigitalOceanProviderRequestContext;
  dependencies: RunnerReplacementReconcilerDependencies;
  now: Date;
}): Promise<RunnerReplacementReconcileResult> {
  const target = await readTarget(input.connection, input.claim);
  if (!target) return await failClaim(input.connection, input.claim, input.now, "state_invalid");
  const confirm = input.dependencies.confirmReadiness ?? confirmCloudRunnerReadiness;
  const readiness = await confirm(target.id, {
    createConnection: () => input.connection,
    now: () => input.now,
    runnerBearerToken: input.config.runnerBearerToken,
    allowInsecureLoopback: input.config.providerMode === "local_docker",
    compatibilityRequirement: compatibilityRequirement(input.config),
  });

  if (
    readiness.outcome === "ready" ||
    (readiness.outcome === "not_applicable" && readiness.reason === "already_ready")
  ) {
    const [capacity] = await input.connection.db.execute<{ assigned: number }>(sql`
      select count(*)::int as assigned
      from ${agents}
      where ${agents.runnerId} = ${input.claim.sourceRunnerId}
        and ${agents.deletedAt} is null
    `);
    const maxAgents = input.config.runnerMaxAgents ?? 1;
    const refreshed = await readTarget(input.connection, input.claim);
    const [heartbeat] = await input.connection.db
      .select({ status: runnerHeartbeats.status, observedAt: runnerHeartbeats.observedAt })
      .from(runnerHeartbeats)
      .where(eq(runnerHeartbeats.runnerId, target.id))
      .orderBy(desc(runnerHeartbeats.observedAt), desc(runnerHeartbeats.createdAt))
      .limit(1);
    const heartbeatFresh =
      heartbeat?.status === "online" &&
      input.now.getTime() - heartbeat.observedAt.getTime() < RUNNER_HEARTBEAT_STALE_THRESHOLD_MS;
    if (
      Number(capacity?.assigned ?? 0) <= maxAgents &&
      heartbeatFresh &&
      refreshed?.provisioningStatus === "ready" &&
      refreshed.compatibilityState === "compatible"
    ) {
      const advanced = await applyClaimedRunnerReplacementTransition({
        db: input.connection.db,
        claim: input.claim,
        action: { kind: "advance" },
        now: input.now,
      });
      if (advanced) {
        return { outcome: "advanced", replacementId: input.claim.id, state: "fencing_source" };
      }
    }
    return await cleanupFailedTarget({ ...input, terminalCode: "target_validation_failed" });
  }

  if (input.claim.attemptCount >= (input.dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
    return await cleanupFailedTarget({ ...input, terminalCode: "target_validation_failed" });
  }
  return await scheduleRetry(input.connection, input.claim, input.now, input.dependencies.retryMs);
}

async function reconcileFencingSource(input: {
  connection: DatabaseConnection;
  claim: ClaimedRunnerReplacement;
  context: DigitalOceanProviderRequestContext;
  dependencies: RunnerReplacementReconcilerDependencies;
  now: Date;
}): Promise<RunnerReplacementReconcileResult> {
  const fenced = await input.connection.db.transaction(async (tx) => {
    const [source] = await tx
      .update(runners)
      .set({ status: "degraded", updatedAt: input.now })
      .where(sql`
        ${runners.id} = ${input.claim.sourceRunnerId}
        and ${runners.deletedAt} is null
        and exists (
          select 1 from ${runnerReplacements}
          where ${runnerReplacements.id} = ${input.claim.id}
            and ${runnerReplacements.generation} = ${input.claim.generation}
            and ${runnerReplacements.state} = 'fencing_source'
            and ${runnerReplacements.leaseOwner} = ${input.claim.leaseOwner}
            and ${runnerReplacements.leaseExpiresAt} > ${input.now.toISOString()}
        )
      `)
      .returning({ id: runners.id });
    return source !== undefined;
  });
  if (!fenced)
    return await failClaim(input.connection, input.claim, input.now, "source_fence_failed");

  const source = await readSourceForHandover(input.connection, input.claim.sourceRunnerId);
  if (!source)
    return await failClaim(input.connection, input.claim, input.now, "source_fence_failed");
  const assigned = await input.connection.db
    .select({ id: agents.id, status: agents.status })
    .from(agents)
    .where(and(eq(agents.runnerId, source.id), isNull(agents.deletedAt)));
  const adapter = input.dependencies.stopSourceAgent
    ? null
    : new ManualRunnerAdapter(source, {
        createConnection: () => input.connection,
        signal: input.context.signal,
      });
  const stopAttempts: Array<Promise<unknown> | undefined> = [];

  for (const agent of assigned) {
    if (agent.status !== "stopped") {
      stopAttempts.push(
        input.dependencies.stopSourceAgent
          ? input.dependencies.stopSourceAgent(source, agent.id)
          : adapter?.stop(agent.id),
      );
    }
  }

  await Promise.allSettled(stopAttempts);

  const advanced = await input.connection.db.transaction(async (tx) => {
    const applied = await applyClaimedRunnerReplacementTransition({
      db: tx,
      claim: input.claim,
      action: { kind: "advance" },
      now: input.now,
    });
    if (!applied) return false;
    await tx
      .update(runnerCredentials)
      .set({ status: "revoked", revokedAt: input.now, updatedAt: input.now })
      .where(and(eq(runnerCredentials.runnerId, source.id), isNull(runnerCredentials.revokedAt)));
    await tx
      .update(runnerRegistrationTokens)
      .set({ status: "revoked", revokedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(runnerRegistrationTokens.runnerId, source.id),
          eq(runnerRegistrationTokens.status, "pending"),
        ),
      );
    if (assigned.length > 0) {
      await tx.insert(agentEvents).values(
        assigned.map((agent) => ({
          agentId: agent.id,
          actorUserId: source.userId,
          type: "agent.runner_replacement_fenced",
          message: "The previous runner was fenced for automatic replacement.",
          metadata: { replacementId: input.claim.id },
          createdAt: input.now,
        })),
      );
    }
    return true;
  });
  return advanced
    ? { outcome: "advanced", replacementId: input.claim.id, state: "reassigning" }
    : { outcome: "retry_scheduled", replacementId: input.claim.id, state: input.claim.state };
}

async function reconcileReassigning(input: {
  connection: DatabaseConnection;
  claim: ClaimedRunnerReplacement;
  config: DigitalOceanProviderConfig;
  dependencies: RunnerReplacementReconcilerDependencies;
  now: Date;
}): Promise<RunnerReplacementReconcileResult> {
  const targetRunnerId = input.claim.targetRunnerId;
  if (!targetRunnerId) {
    return await failClaim(input.connection, input.claim, input.now, "state_invalid");
  }
  let handover: { deploymentIds: string[]; runningAgentIds: string[] };
  try {
    handover = await input.connection.db.transaction(async (tx) => {
      const [firstRunnerId, secondRunnerId] = [input.claim.sourceRunnerId, targetRunnerId].sort();
      if (!firstRunnerId || !secondRunnerId) throw new Error("Replacement runner pair is invalid.");
      await lockRunnerPlacementCapacityInTransaction(tx, firstRunnerId);
      await lockRunnerPlacementCapacityInTransaction(tx, secondRunnerId);
      const [pair] = await tx.execute<{
        sourceUserId: string;
        sourceStatus: string;
        targetStatus: string;
        targetProvisioningStatus: string | null;
        targetCompatibilityState: string;
        targetHeartbeatStatus: string | null;
        targetHeartbeatObservedAt: Date | string | null;
      }>(sql`
        select
          source_runner.user_id as "sourceUserId",
          source_runner.status as "sourceStatus",
          target_runner.status as "targetStatus",
          target_runner.provisioning_status as "targetProvisioningStatus",
          target_runner.compatibility_state as "targetCompatibilityState",
          latest_heartbeat.status as "targetHeartbeatStatus",
          latest_heartbeat.observed_at as "targetHeartbeatObservedAt"
        from ${runners} as source_runner
        inner join ${runners} as target_runner
          on target_runner.id = ${input.claim.targetRunnerId}
         and target_runner.user_id = source_runner.user_id
         and target_runner.deleted_at is null
        left join lateral (
          select status, observed_at
          from ${runnerHeartbeats}
          where ${runnerHeartbeats.runnerId} = target_runner.id
          order by observed_at desc, created_at desc
          limit 1
        ) as latest_heartbeat on true
        where source_runner.id = ${input.claim.sourceRunnerId}
          and source_runner.deleted_at is null
        for update of source_runner, target_runner
      `);
      if (
        pair?.sourceStatus !== "degraded" ||
        pair.targetStatus !== "online" ||
        pair.targetProvisioningStatus !== "ready" ||
        pair.targetCompatibilityState !== "compatible" ||
        pair.targetHeartbeatStatus !== "online" ||
        !pair.targetHeartbeatObservedAt ||
        input.now.getTime() - new Date(pair.targetHeartbeatObservedAt).getTime() >=
          RUNNER_HEARTBEAT_STALE_THRESHOLD_MS
      ) {
        throw new Error("Replacement handover runner pair is not fenced and ready.");
      }
      const [authority] = await tx
        .select({ id: runnerCredentials.id })
        .from(runnerCredentials)
        .where(
          and(
            eq(runnerCredentials.runnerId, input.claim.sourceRunnerId),
            isNull(runnerCredentials.revokedAt),
          ),
        )
        .limit(1);
      if (authority) throw new Error("Replacement source still has command authority.");

      const assigned = await tx
        .select({
          id: agents.id,
          userId: agents.userId,
          desiredStatus: agents.desiredStatus,
        })
        .from(agents)
        .where(and(eq(agents.runnerId, input.claim.sourceRunnerId), isNull(agents.deletedAt)))
        .orderBy(agents.id)
        .for("update");
      const [{ assigned: targetAssigned = 0 } = { assigned: 0 }] = await tx.execute<{
        assigned: number;
      }>(sql`
        select count(*)::int as assigned
        from ${agents}
        where ${agents.runnerId} = ${input.claim.targetRunnerId}
          and ${agents.deletedAt} is null
      `);
      if (assigned.length + Number(targetAssigned) > (input.config.runnerMaxAgents ?? 1)) {
        throw new Error("Replacement target no longer has sufficient capacity.");
      }

      if (assigned.some((agent) => agent.userId !== pair.sourceUserId)) {
        throw new Error("Replacement agent owner does not match the runner pair.");
      }
      const runningAgents = assigned.filter((agent) => agent.desiredStatus === "running");
      const deployments = await Promise.all(
        runningAgents.map((agent) =>
          createAgentDeploymentForRunnerReplacement({
            tx,
            replacementId: input.claim.id,
            agentId: agent.id,
            userId: agent.userId,
            now: input.now,
          }),
        ),
      );
      if (deployments.some((deployment) => deployment === null)) {
        throw new Error("Replacement deployment could not be created.");
      }
      const deploymentIds = deployments.flatMap((deployment) =>
        deployment === null ? [] : [deployment.deploymentId],
      );
      const runningAgentIds = runningAgents.map((agent) => agent.id);

      if (assigned.length > 0) {
        const assignedIds = assigned.map((agent) => agent.id);
        await tx
          .update(agentUsagePeriods)
          .set({ stoppedAt: input.now, updatedAt: input.now })
          .where(
            and(
              inArray(agentUsagePeriods.agentId, assignedIds),
              isNull(agentUsagePeriods.stoppedAt),
            ),
          );
        await tx
          .delete(agentRuntimeReconciliations)
          .where(inArray(agentRuntimeReconciliations.agentId, assignedIds));
        await tx
          .update(agents)
          .set({
            runnerId: input.claim.targetRunnerId,
            status: sql`case when ${agents.desiredStatus} = 'running' then 'starting'::agent_status else 'stopped'::agent_status end`,
            statusReason: sql`case when ${agents.desiredStatus} = 'running' then 'Recovering on a validated replacement runner.' else null end`,
            updatedAt: input.now,
          })
          .where(
            and(
              inArray(agents.id, assignedIds),
              eq(agents.runnerId, input.claim.sourceRunnerId),
              isNull(agents.deletedAt),
            ),
          );
        await tx.insert(agentEvents).values(
          assigned.map((agent) => ({
            agentId: agent.id,
            actorUserId: agent.userId,
            type: "agent.runner_reassigned",
            message: "Agent assigned to a validated replacement runner.",
            metadata: {
              replacementId: input.claim.id,
              desiredStatus: agent.desiredStatus,
            },
            createdAt: input.now,
          })),
        );
      }

      const applied = await applyClaimedRunnerReplacementTransition({
        db: tx,
        claim: input.claim,
        action: { kind: "advance" },
        now: input.now,
      });
      if (!applied) throw new Error("Replacement reassignment lost its claim fence.");
      return { deploymentIds, runningAgentIds };
    });
  } catch {
    return await failClaim(input.connection, input.claim, input.now, "reassignment_failed");
  }

  for (const deploymentId of handover.deploymentIds) {
    (input.dependencies.triggerDeployment ?? scheduleAgentDeploymentReconcileAfterResponse)(
      deploymentId,
    );
  }
  for (const agentId of handover.runningAgentIds) {
    (input.dependencies.triggerRuntime ?? scheduleAgentRuntimeReconcileAfterResponse)(agentId);
  }
  return { outcome: "advanced", replacementId: input.claim.id, state: "converging_agents" };
}

async function reconcileConvergingAgents(input: {
  connection: DatabaseConnection;
  claim: ClaimedRunnerReplacement;
  dependencies: RunnerReplacementReconcilerDependencies;
  now: Date;
}): Promise<RunnerReplacementReconcileResult> {
  if (!input.claim.targetRunnerId) {
    return await failClaim(input.connection, input.claim, input.now, "state_invalid");
  }
  const moved = await input.connection.db
    .select({
      id: agents.id,
      userId: agents.userId,
      desiredStatus: agents.desiredStatus,
      status: agents.status,
    })
    .from(agents)
    .where(sql`
      ${agents.runnerId} = ${input.claim.targetRunnerId}
      and ${agents.deletedAt} is null
      and exists (
        select 1 from ${agentEvents}
        where ${agentEvents.agentId} = ${agents.id}
          and ${agentEvents.type} = 'agent.runner_reassigned'
          and ${agentEvents.metadata} ->> 'replacementId' = ${input.claim.id}
      )
    `)
    .orderBy(agents.id);

  let converged = true;
  for (const agent of moved) {
    if (agent.desiredStatus === "stopped") {
      converged &&= agent.status === "stopped";
      continue;
    }
    const [deployment] = await input.connection.db
      .select({
        id: agentDeployments.id,
        stage: agentDeployments.stage,
        completedAt: agentDeployments.completedAt,
      })
      .from(agentDeployments)
      .where(and(eq(agentDeployments.agentId, agent.id), eq(agentDeployments.userId, agent.userId)))
      .orderBy(desc(agentDeployments.createdAt), desc(agentDeployments.id))
      .limit(1);
    if (!deployment) {
      return await failClaim(input.connection, input.claim, input.now, "agent_convergence_failed");
    }
    if (deployment.stage === "failed") {
      const retry = input.dependencies.retryDeployment ?? retryAgentDeploymentForUser;
      const retried = await retry({
        userId: agent.userId,
        agentId: agent.id,
        idempotencyKey: `runner-replacement-retry:${input.claim.id}:${deployment.id}`,
        dependencies: {
          createConnection: () => input.connection,
          now: () => new Date(input.now.getTime() + 1),
          onDeploymentCommitted:
            input.dependencies.triggerDeployment ?? scheduleAgentDeploymentReconcileAfterResponse,
        },
      });
      if (!retried.ok) {
        return await scheduleRetry(
          input.connection,
          input.claim,
          input.now,
          input.dependencies.retryMs,
        );
      }
      converged = false;
      continue;
    }
    if (deployment.stage !== "ready" || !deployment.completedAt) {
      (input.dependencies.triggerDeployment ?? scheduleAgentDeploymentReconcileAfterResponse)(
        deployment.id,
      );
      converged = false;
      continue;
    }
    const [runtime] = await input.connection.db
      .select({
        state: agentRuntimeReconciliations.state,
        lastReadyAt: agentRuntimeReconciliations.lastReadyAt,
      })
      .from(agentRuntimeReconciliations)
      .where(eq(agentRuntimeReconciliations.agentId, agent.id))
      .limit(1);
    if (
      agent.status !== "running" ||
      runtime?.state !== "observing" ||
      !runtime.lastReadyAt ||
      runtime.lastReadyAt < deployment.completedAt
    ) {
      (input.dependencies.triggerRuntime ?? scheduleAgentRuntimeReconcileAfterResponse)(agent.id);
      converged = false;
    }
  }

  if (!converged) {
    return await scheduleRetry(
      input.connection,
      input.claim,
      input.now,
      input.dependencies.retryMs,
    );
  }
  const advanced = await applyClaimedRunnerReplacementTransition({
    db: input.connection.db,
    claim: input.claim,
    action: { kind: "advance" },
    now: input.now,
  });
  return advanced
    ? { outcome: "advanced", replacementId: input.claim.id, state: "cleaning_source" }
    : { outcome: "retry_scheduled", replacementId: input.claim.id, state: input.claim.state };
}

async function reconcileCleaningSource(input: {
  connection: DatabaseConnection;
  claim: ClaimedRunnerReplacement;
  provider: DigitalOceanProvider;
  context: DigitalOceanProviderRequestContext;
  dependencies: RunnerReplacementReconcilerDependencies;
  now: Date;
}): Promise<RunnerReplacementReconcileResult> {
  const source = await readSourceForHandover(input.connection, input.claim.sourceRunnerId);
  if (!source?.provisioningOperationKey) {
    return await failClaim(input.connection, input.claim, input.now, "source_cleanup_failed");
  }
  const [remaining] = await input.connection.db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.runnerId, source.id), isNull(agents.deletedAt)))
    .limit(1);
  if (remaining) {
    return await scheduleRetry(
      input.connection,
      input.claim,
      input.now,
      input.dependencies.retryMs,
    );
  }

  const discovered = await input.provider.discoverResourcesByTag(
    { tag: source.provisioningOperationKey },
    input.context,
  );
  if (!discovered.ok || !discovered.value.authoritative || discovered.value.resources.length > 1) {
    return await scheduleRetry(
      input.connection,
      input.claim,
      input.now,
      input.dependencies.retryMs,
    );
  }
  const resource = discovered.value.resources[0];
  if (
    resource &&
    (resource.providerResourceId !== source.providerResourceId ||
      resource.name !== source.provisioningOperationKey ||
      !resource.tags.includes(source.provisioningOperationKey))
  ) {
    return await scheduleRetry(
      input.connection,
      input.claim,
      input.now,
      input.dependencies.retryMs,
    );
  }
  if (!resource && source.providerResourceId) {
    if (source.providerFirewallId && source.region && source.sizeSlug) {
      const owned = asOwnedSetProvider(input.provider);
      if (!owned) {
        return await scheduleRetry(
          input.connection,
          input.claim,
          input.now,
          input.dependencies.retryMs,
        );
      }
      const absent = await owned.observeOwnedSet(
        {
          operationTag: source.provisioningOperationKey,
          providerResourceId: source.providerResourceId,
          providerFirewallId: source.providerFirewallId,
          expectedName: source.provisioningOperationKey,
          expectedRegion: source.region,
          expectedSizeSlug: source.sizeSlug,
          expectedFirewallName: digitalOceanRunnerFirewallName(source.providerResourceId),
        },
        input.context,
      );
      if (!absent.ok || absent.value.state !== "absent") {
        return await scheduleRetry(
          input.connection,
          input.claim,
          input.now,
          input.dependencies.retryMs,
        );
      }
    } else {
      const observed = await input.provider.readResource(
        { providerResourceId: source.providerResourceId },
        input.context,
      );
      if (observed.ok || observed.reason !== "resource_not_found") {
        return await scheduleRetry(
          input.connection,
          input.claim,
          input.now,
          input.dependencies.retryMs,
        );
      }
    }
  }
  if (resource) {
    if (source.providerFirewallId && source.region && source.sizeSlug) {
      const owned = asOwnedSetProvider(input.provider);
      if (!owned) {
        return await scheduleRetry(
          input.connection,
          input.claim,
          input.now,
          input.dependencies.retryMs,
        );
      }
      const expectation = {
        operationTag: source.provisioningOperationKey,
        providerResourceId: resource.providerResourceId,
        providerFirewallId: source.providerFirewallId,
        expectedName: source.provisioningOperationKey,
        expectedRegion: source.region,
        expectedSizeSlug: source.sizeSlug,
        expectedFirewallName: digitalOceanRunnerFirewallName(resource.providerResourceId),
      };
      const observed = await owned.observeOwnedSet(expectation, input.context);
      if (!observed.ok) {
        return await scheduleRetry(
          input.connection,
          input.claim,
          input.now,
          input.dependencies.retryMs,
        );
      }
      if (observed.value.firewall === "present") {
        const deleted = await owned.deleteFirewall(expectation, input.context);
        if (!deleted.ok) {
          return await scheduleRetry(
            input.connection,
            input.claim,
            input.now,
            input.dependencies.retryMs,
          );
        }
      }
      if (observed.value.droplet === "present") {
        const deleted = await owned.deleteDroplet(expectation, input.context);
        if (!deleted.ok) {
          return await scheduleRetry(
            input.connection,
            input.claim,
            input.now,
            input.dependencies.retryMs,
          );
        }
      }
      const absent = await owned.observeOwnedSet(expectation, input.context);
      if (!absent.ok || absent.value.state !== "absent") {
        return await scheduleRetry(
          input.connection,
          input.claim,
          input.now,
          input.dependencies.retryMs,
        );
      }
    } else {
      const deleted = await input.provider.cleanupResource(
        { providerResourceId: resource.providerResourceId },
        input.context,
      );
      if (!deleted.ok) {
        return await scheduleRetry(
          input.connection,
          input.claim,
          input.now,
          input.dependencies.retryMs,
        );
      }
    }
  }

  const completed = await input.connection.db.transaction(async (tx) => {
    const applied = await applyClaimedRunnerReplacementTransition({
      db: tx,
      claim: input.claim,
      action: { kind: "advance" },
      now: input.now,
    });
    if (!applied) return false;
    await tx
      .update(runnerRegistrationTokens)
      .set({ status: "revoked", revokedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(runnerRegistrationTokens.runnerId, source.id),
          eq(runnerRegistrationTokens.status, "pending"),
        ),
      );
    await tx
      .update(runnerCredentials)
      .set({ status: "revoked", revokedAt: input.now, updatedAt: input.now })
      .where(and(eq(runnerCredentials.runnerId, source.id), isNull(runnerCredentials.revokedAt)));
    await tx
      .update(agents)
      .set({ runnerId: null, updatedAt: input.now })
      .where(eq(agents.runnerId, source.id));
    await tx
      .update(runners)
      .set({
        status: "deleted",
        provisioningStatus: "deleted",
        deletedAt: input.now,
        provisioningCompletedAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(runners.id, source.id));
    await tx.insert(runnerProvisioningEvents).values({
      runnerId: source.id,
      phase: "deleted",
      status: "completed",
      message: "Obsolete runner removed after automatic replacement.",
      metadata: { replacementId: input.claim.id },
      createdAt: input.now,
    });
    if (input.claim.targetRunnerId) {
      const moved = await tx
        .select({ id: agents.id, userId: agents.userId })
        .from(agents)
        .where(sql`
          ${agents.runnerId} = ${input.claim.targetRunnerId}
          and ${agents.deletedAt} is null
          and exists (
            select 1 from ${agentEvents}
            where ${agentEvents.agentId} = ${agents.id}
              and ${agentEvents.type} = 'agent.runner_reassigned'
              and ${agentEvents.metadata} ->> 'replacementId' = ${input.claim.id}
          )
        `);
      if (moved.length > 0) {
        await tx.insert(agentEvents).values(
          moved.map((agent) => ({
            agentId: agent.id,
            actorUserId: agent.userId,
            type: "agent.runner_replacement_completed",
            message: "Automatic runner replacement completed.",
            metadata: { replacementId: input.claim.id },
            createdAt: input.now,
          })),
        );
      }
    }
    return true;
  });
  return completed
    ? { outcome: "advanced", replacementId: input.claim.id, state: "complete" }
    : { outcome: "retry_scheduled", replacementId: input.claim.id, state: input.claim.state };
}

async function cleanupFailedTarget(input: {
  connection: DatabaseConnection;
  claim: ClaimedRunnerReplacement;
  provider: DigitalOceanProvider;
  context: DigitalOceanProviderRequestContext;
  now: Date;
  terminalCode: "target_provisioning_failed" | "target_validation_failed";
  dependencies: RunnerReplacementReconcilerDependencies;
}): Promise<RunnerReplacementReconcileResult> {
  const target = await readTarget(input.connection, input.claim);
  if (!target) return await failClaim(input.connection, input.claim, input.now, input.terminalCode);
  const operationKey = target.provisioningOperationKey;
  if (!operationKey) {
    return await failClaim(input.connection, input.claim, input.now, input.terminalCode);
  }
  const discovered = await input.provider.discoverResourcesByTag(
    { tag: operationKey },
    input.context,
  );
  if (!discovered.ok || !discovered.value.authoritative) {
    return await retryCleanupOrFail(input);
  }
  if (discovered.value.resources.length > 1) {
    return await failClaim(input.connection, input.claim, input.now, input.terminalCode);
  }
  const resource = discovered.value.resources[0];
  if (
    resource &&
    (resource.providerResourceId !== target.providerResourceId ||
      resource.name !== operationKey ||
      !resource.tags.includes(operationKey))
  ) {
    return await failClaim(input.connection, input.claim, input.now, input.terminalCode);
  }
  if (!resource && target.providerResourceId) {
    if (target.providerFirewallId && target.region && target.sizeSlug) {
      const owned = asOwnedSetProvider(input.provider);
      if (!owned) return await retryCleanupOrFail(input);
      const absent = await owned.observeOwnedSet(
        {
          operationTag: operationKey,
          providerResourceId: target.providerResourceId,
          providerFirewallId: target.providerFirewallId,
          expectedName: operationKey,
          expectedRegion: target.region,
          expectedSizeSlug: target.sizeSlug,
          expectedFirewallName: digitalOceanRunnerFirewallName(target.providerResourceId),
        },
        input.context,
      );
      if (!absent.ok || absent.value.state !== "absent") return await retryCleanupOrFail(input);
    } else {
      const observed = await input.provider.readResource(
        { providerResourceId: target.providerResourceId },
        input.context,
      );
      if (observed.ok || observed.reason !== "resource_not_found") {
        return await retryCleanupOrFail(input);
      }
    }
  }
  if (resource) {
    if (target.providerFirewallId) {
      if (!target.region || !target.sizeSlug) {
        return await failClaim(input.connection, input.claim, input.now, "state_invalid");
      }
      const ownedSetProvider = asOwnedSetProvider(input.provider);
      if (!ownedSetProvider) return await retryCleanupOrFail(input);
      const expectation = {
        operationTag: operationKey,
        providerResourceId: resource.providerResourceId,
        providerFirewallId: target.providerFirewallId,
        expectedName: operationKey,
        expectedRegion: target.region,
        expectedSizeSlug: target.sizeSlug,
        expectedFirewallName: digitalOceanRunnerFirewallName(resource.providerResourceId),
      };
      const observed = await ownedSetProvider.observeOwnedSet(expectation, input.context);
      if (!observed.ok) {
        return observed.reason === "ownership_ambiguous"
          ? await failClaim(input.connection, input.claim, input.now, input.terminalCode)
          : await retryCleanupOrFail(input);
      }
      if (observed.value.firewall === "present") {
        const firewall = await ownedSetProvider.deleteFirewall(expectation, input.context);
        if (!firewall.ok) {
          return firewall.reason === "ownership_ambiguous"
            ? await failClaim(input.connection, input.claim, input.now, input.terminalCode)
            : await retryCleanupOrFail(input);
        }
      }
      if (observed.value.droplet === "present") {
        const droplet = await ownedSetProvider.deleteDroplet(expectation, input.context);
        if (!droplet.ok) {
          return droplet.reason === "ownership_ambiguous"
            ? await failClaim(input.connection, input.claim, input.now, input.terminalCode)
            : await retryCleanupOrFail(input);
        }
      }
      const absent = await ownedSetProvider.observeOwnedSet(expectation, input.context);
      if (!absent.ok || absent.value.state !== "absent") {
        return await retryCleanupOrFail(input);
      }
    } else {
      const cleanup = await input.provider.cleanupResource(
        { providerResourceId: resource.providerResourceId },
        input.context,
      );
      if (!cleanup.ok) return await retryCleanupOrFail(input);
    }
  }

  const terminalTransitionApplied = await input.connection.db.transaction(async (tx) => {
    const applied = await applyClaimedRunnerReplacementTransition({
      db: tx,
      claim: input.claim,
      action: { kind: "fail", code: input.terminalCode },
      now: input.now,
    });
    if (!applied) return false;
    await tx
      .update(runnerRegistrationTokens)
      .set({ status: "revoked", revokedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(runnerRegistrationTokens.runnerId, target.id),
          eq(runnerRegistrationTokens.status, "pending"),
        ),
      );
    await tx
      .update(runnerCredentials)
      .set({ status: "revoked", revokedAt: input.now, updatedAt: input.now })
      .where(eq(runnerCredentials.runnerId, target.id));
    await tx
      .update(runners)
      .set({
        status: "deleted",
        provisioningStatus: "deleted",
        deletedAt: input.now,
        provisioningCompletedAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(runners.id, target.id));
    return true;
  });
  return {
    outcome: terminalTransitionApplied ? "failed" : "retry_scheduled",
    replacementId: input.claim.id,
    state: terminalTransitionApplied ? "failed" : input.claim.state,
  };
}

async function readTarget(connection: DatabaseConnection, claim: ClaimedRunnerReplacement) {
  if (!claim.targetRunnerId) return null;
  const [target] = await connection.db
    .select({
      id: runners.id,
      userId: runners.userId,
      region: runners.region,
      sizeSlug: runners.sizeSlug,
      providerResourceId: runners.providerResourceId,
      providerFirewallId: runners.providerFirewallId,
      provisioningOperationKey: runners.provisioningOperationKey,
      provisioningStatus: runners.provisioningStatus,
      compatibilityState: runners.compatibilityState,
    })
    .from(runners)
    .where(and(eq(runners.id, claim.targetRunnerId), isNull(runners.deletedAt)))
    .limit(1);
  return target?.provisioningOperationKey ? target : null;
}

async function readSourceForHandover(
  connection: DatabaseConnection,
  sourceRunnerId: string,
): Promise<
  | (ManualRunnerRecord & {
      provisioningOperationKey: string | null;
      providerResourceId: string | null;
      providerFirewallId: string | null;
      region: string | null;
      sizeSlug: string | null;
    })
  | null
> {
  const [source] = await connection.db
    .select({
      id: runners.id,
      userId: runners.userId,
      name: runners.name,
      kind: runners.kind,
      endpointUrl: runners.endpointUrl,
      status: runners.status,
      provisioningOperationKey: runners.provisioningOperationKey,
      providerResourceId: runners.providerResourceId,
      providerFirewallId: runners.providerFirewallId,
      region: runners.region,
      sizeSlug: runners.sizeSlug,
      createdAt: runners.createdAt,
      updatedAt: runners.updatedAt,
      deletedAt: runners.deletedAt,
    })
    .from(runners)
    .where(
      and(
        eq(runners.id, sourceRunnerId),
        eq(runners.kind, "digitalocean"),
        eq(runners.provider, DIGITALOCEAN_PROVIDER),
        isNull(runners.deletedAt),
      ),
    )
    .limit(1);
  if (!source?.endpointUrl) return null;
  return {
    ...source,
    kind: "digitalocean",
    endpointUrl: source.endpointUrl,
    status: source.status as ManualRunnerRecord["status"],
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
    deletedAt: null,
  };
}

async function scheduleRetry(
  connection: DatabaseConnection,
  claim: ClaimedRunnerReplacement,
  now: Date,
  retryMs = DEFAULT_RETRY_MS,
): Promise<RunnerReplacementReconcileResult> {
  const nextAttemptAt = new Date(now.getTime() + retryMs);
  const applied = await applyClaimedRunnerReplacementTransition({
    db: connection.db,
    claim,
    action: { kind: "retry", nextAttemptAt },
    now,
  });
  return {
    outcome: applied ? "retry_scheduled" : "failed",
    replacementId: claim.id,
    state: claim.state,
  };
}

async function failClaim(
  connection: DatabaseConnection,
  claim: ClaimedRunnerReplacement,
  now: Date,
  code:
    | "target_provisioning_failed"
    | "target_validation_failed"
    | "source_fence_failed"
    | "reassignment_failed"
    | "agent_convergence_failed"
    | "source_cleanup_failed"
    | "state_invalid",
): Promise<RunnerReplacementReconcileResult> {
  await applyClaimedRunnerReplacementTransition({
    db: connection.db,
    claim,
    action: { kind: "fail", code },
    now,
  });
  return { outcome: "failed", replacementId: claim.id, state: "failed" };
}

function provisioningOperationKeyFor(operationKey: string): string {
  return `agentbay-deploy-${operationKey.slice("agentbay-replace-".length)}`;
}

function isInfrastructureReplacementSourceEligible(
  source: {
    status: string;
    provisioningStatus: string | null;
    compatibilityState: string;
  },
  reason: RunnerReplacementReason,
): boolean {
  if (reason === "boot_failure") return source.provisioningStatus === "failed";
  if (reason === "provider_resource_missing") {
    return source.provisioningStatus === "ready" || source.provisioningStatus === "failed";
  }
  if (source.provisioningStatus !== "ready") return false;
  if (reason === "release_mismatch") return source.compatibilityState !== "compatible";
  if (reason === "stale_heartbeat") return ["offline", "degraded"].includes(source.status);
  return false;
}

function isReplacementConfigUsable(config: DigitalOceanProviderConfig): boolean {
  return (
    config.providerMode === "digitalocean" && requiredRunnerImageDigestForProvider(config) !== null
  );
}

function asOwnedSetProvider(provider: DigitalOceanProvider): DigitalOceanOwnedSetProvider | null {
  const candidate = provider as Partial<DigitalOceanOwnedSetProvider>;
  return typeof candidate.observeOwnedSet === "function" &&
    typeof candidate.deleteFirewall === "function" &&
    typeof candidate.deleteDroplet === "function"
    ? (candidate as DigitalOceanOwnedSetProvider)
    : null;
}

async function retryCleanupOrFail(input: {
  connection: DatabaseConnection;
  claim: ClaimedRunnerReplacement;
  now: Date;
  terminalCode: "target_provisioning_failed" | "target_validation_failed";
  dependencies: RunnerReplacementReconcilerDependencies;
}): Promise<RunnerReplacementReconcileResult> {
  return input.claim.attemptCount >= (input.dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
    ? await failClaim(input.connection, input.claim, input.now, input.terminalCode)
    : await scheduleRetry(input.connection, input.claim, input.now, input.dependencies.retryMs);
}

function compatibilityRequirement(
  config: DigitalOceanProviderConfig,
): RunnerCompatibilityRequirement {
  if (config.providerMode === "local_docker") return { mode: "local_docker", release: null };
  const parsed = parseImmutableRunnerImageReference(config.runnerImage);
  return parsed
    ? {
        mode: "hosted",
        release: {
          version: parsed.version,
          imageDigest: parsed.imageDigest,
          bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
        },
      }
    : { mode: "unavailable", release: null };
}

function providerDeadline(timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS): {
  context: DigitalOceanProviderRequestContext;
  clear: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { context: { signal: controller.signal }, clear: () => clearTimeout(timeout) };
}
