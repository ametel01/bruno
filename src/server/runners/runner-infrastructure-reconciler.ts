import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentEvents,
  agents,
  runnerCredentials,
  runnerInfrastructureOrphans,
  runnerInfrastructureReconciliations,
  runnerRegistrationTokens,
  runners,
} from "@/src/server/db/schema";
import { type DigitalOceanProviderConfig, readDigitalOceanProviderConfig } from "@/src/server/env";
import {
  DIGITALOCEAN_MANAGED_RUNNER_TAG,
  DIGITALOCEAN_PROVIDER,
  type DigitalOceanOwnedSetProvider,
  type DigitalOceanProvider,
  type DigitalOceanProviderRequestContext,
  type DigitalOceanResource,
} from "@/src/server/runners/digitalocean-provider";
import {
  createConfiguredDigitalOceanProvider,
  digitalOceanRunnerFirewallName,
} from "@/src/server/runners/runner-provisioning";
import type { RunnerReplacementReason } from "@/src/server/runners/runner-replacement-state";
import { createOrGetRunnerReplacement } from "@/src/server/runners/runner-replacement-store";

const SCOPE_KEY = "global";
const OPERATION_TAG_PATTERN = /^agentbay-deploy-[0-9a-f]{32}$/;
const DEFAULT_LEASE_MS = 90_000;
const DEFAULT_RETRY_MS = 5_000;
const DEFAULT_ORPHAN_GRACE_MS = 10 * 60 * 1_000;
const DEFAULT_INVENTORY_LIMIT = 200;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

export type RunnerInfrastructureReconcileOutcome =
  | "idle"
  | "exact_match"
  | "replacement_started"
  | "stale_runner_tombstoned"
  | "interrupted_runner_adopted"
  | "duplicate_resources"
  | "stale_assignment_cleared"
  | "provisioning_in_progress"
  | "orphan_observed"
  | "orphan_deleted"
  | "ambiguous_resource"
  | "provider_unavailable";

export type RunnerInfrastructureReconcileResult = {
  processed: 0 | 1;
  outcome: RunnerInfrastructureReconcileOutcome;
};

export type RunnerInfrastructureReconcilerDependencies = {
  createConnection?: () => DatabaseConnection;
  inventoryLimit?: number;
  leaseMs?: number;
  now?: () => Date;
  orphanGraceMs?: number;
  provider?: DigitalOceanProvider;
  providerTimeoutMs?: number;
  randomUUID?: () => string;
  readConfig?: () => DigitalOceanProviderConfig | null;
  retryMs?: number;
};

type InfrastructureClaim = {
  generation: number;
  leaseOwner: string;
  leaseExpiresAt: Date | string;
};

type InventoryRunner = {
  id: string;
  userId: string;
  status: string;
  compatibilityState: string;
  provisioningStatus: string | null;
  provisioningOperationKey: string | null;
  providerResourceId: string | null;
  deletedAt: Date | null;
  assignedCount: number;
};

export async function reconcileNextRunnerInfrastructure(
  dependencies: RunnerInfrastructureReconcilerDependencies = {},
): Promise<RunnerInfrastructureReconcileResult> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const observedAt = now();
  const leaseOwner = `runner-infrastructure:${(dependencies.randomUUID ?? randomUUID)()}`;
  let claim: InfrastructureClaim | null = null;

  try {
    claim = await claimInfrastructure(connection, {
      leaseOwner,
      now: observedAt,
      leaseMs: dependencies.leaseMs ?? DEFAULT_LEASE_MS,
    });
    if (!claim) return { processed: 0, outcome: "idle" };

    let config: DigitalOceanProviderConfig | null;
    try {
      config = dependencies.readConfig?.() ?? readDigitalOceanProviderConfig();
    } catch {
      return { processed: 1, outcome: "provider_unavailable" };
    }
    if (config?.providerMode !== "digitalocean") {
      return { processed: 1, outcome: "provider_unavailable" };
    }
    const provider = dependencies.provider ?? createConfiguredDigitalOceanProvider(config);
    if (!provider.listManagedResources) {
      return { processed: 1, outcome: "provider_unavailable" };
    }
    const deadline = providerDeadline(dependencies.providerTimeoutMs);
    try {
      const inventory = await provider
        .listManagedResources({ stableTag: DIGITALOCEAN_MANAGED_RUNNER_TAG }, deadline.context)
        .catch(() => null);
      if (!inventory?.ok || !inventory.value.authoritative) {
        return { processed: 1, outcome: "provider_unavailable" };
      }
      const limit = normalizeLimit(dependencies.inventoryLimit);
      const resources = inventory.value.resources
        .filter((resource) => resource.deletedAt === null)
        .sort((left, right) => left.providerResourceId.localeCompare(right.providerResourceId));
      const inventoryRunners = await readInventoryRunners(connection, limit);

      const staleAssignment = await clearOneStaleAssignment(connection, observedAt);
      if (staleAssignment) return { processed: 1, outcome: "stale_assignment_cleared" };

      for (const runner of inventoryRunners) {
        const operationResources = runner.provisioningOperationKey
          ? resources.filter((resource) =>
              resource.tags.includes(runner.provisioningOperationKey as string),
            )
          : [];
        if (operationResources.length > 1) {
          return { processed: 1, outcome: "duplicate_resources" };
        }

        const byId = runner.providerResourceId
          ? resources.find((resource) => resource.providerResourceId === runner.providerResourceId)
          : undefined;
        if (runner.providerResourceId && !byId) {
          if (runner.assignedCount > 0) {
            if (!isRunnerReplacementEligibleProvisioningStatus(runner.provisioningStatus)) {
              return { processed: 1, outcome: "provisioning_in_progress" };
            }
            const started = await startMissingRunnerReplacement(connection, runner, observedAt, {
              randomUUID: dependencies.randomUUID ?? randomUUID,
            });
            return {
              processed: 1,
              outcome: started ? "replacement_started" : "ambiguous_resource",
            };
          }
          const tombstoned = await tombstoneUnassignedMissingRunner(connection, runner, observedAt);
          return {
            processed: 1,
            outcome: tombstoned ? "stale_runner_tombstoned" : "ambiguous_resource",
          };
        }
        if (
          !runner.providerResourceId &&
          runner.provisioningOperationKey &&
          operationResources.length === 1
        ) {
          const resource = operationResources[0];
          if (!resource || !isExactOwnedResource(resource, runner.provisioningOperationKey)) {
            return { processed: 1, outcome: "ambiguous_resource" };
          }
          const adopted = await adoptInterruptedRunner(connection, runner, resource, observedAt);
          return {
            processed: 1,
            outcome: adopted ? "interrupted_runner_adopted" : "ambiguous_resource",
          };
        }
        if (
          byId &&
          runner.provisioningOperationKey &&
          !isExactOwnedResource(byId, runner.provisioningOperationKey)
        ) {
          return { processed: 1, outcome: "ambiguous_resource" };
        }
        const unhealthyReason = replacementReasonForUnhealthyRunner(runner);
        if (byId && runner.assignedCount > 0 && unhealthyReason) {
          const started = await startRunnerReplacement(connection, runner, observedAt, {
            randomUUID: dependencies.randomUUID ?? randomUUID,
            reason: unhealthyReason,
          });
          return {
            processed: 1,
            outcome: started ? "replacement_started" : "ambiguous_resource",
          };
        }
      }

      const activeProviderIds = new Set(
        inventoryRunners.flatMap((runner) =>
          runner.providerResourceId ? [runner.providerResourceId] : [],
        ),
      );
      const activeOperationTags = new Set(
        inventoryRunners.flatMap((runner) =>
          runner.provisioningOperationKey ? [runner.provisioningOperationKey] : [],
        ),
      );
      const orphanCandidates = resources.filter(
        (resource) =>
          !activeProviderIds.has(resource.providerResourceId) &&
          operationTag(resource) !== null &&
          !activeOperationTags.has(operationTag(resource) as string),
      );
      const grouped = new Map<string, DigitalOceanResource[]>();
      for (const resource of orphanCandidates) {
        const tag = operationTag(resource);
        if (!tag) continue;
        grouped.set(tag, [...(grouped.get(tag) ?? []), resource]);
      }
      if ([...grouped.values()].some((group) => group.length > 1)) {
        return { processed: 1, outcome: "duplicate_resources" };
      }
      const orphan = orphanCandidates.find((resource) => isExactOwnedResource(resource));
      if (orphan) {
        return await reconcileOrphan(connection, provider, orphan, observedAt, deadline.context, {
          orphanGraceMs: dependencies.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS,
        });
      }
      if (orphanCandidates.length > 0) {
        return { processed: 1, outcome: "ambiguous_resource" };
      }
      return { processed: 1, outcome: "exact_match" };
    } finally {
      deadline.clear();
    }
  } finally {
    if (claim) {
      await releaseInfrastructure(connection, claim, observedAt, dependencies.retryMs).catch(
        () => undefined,
      );
    }
    if (ownsConnection) await connection.close();
  }
}

async function claimInfrastructure(
  connection: DatabaseConnection,
  input: { leaseOwner: string; now: Date; leaseMs: number },
): Promise<InfrastructureClaim | null> {
  const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
  return await connection.db.transaction(async (tx) => {
    await tx
      .insert(runnerInfrastructureReconciliations)
      .values({
        scopeKey: SCOPE_KEY,
        nextAttemptAt: input.now,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing();
    const [claimed] = await tx.execute<InfrastructureClaim>(sql`
      update ${runnerInfrastructureReconciliations}
      set lease_owner = ${input.leaseOwner},
          lease_expires_at = ${leaseExpiresAt.toISOString()},
          attempt_count = ${runnerInfrastructureReconciliations.attemptCount} + 1,
          updated_at = ${input.now.toISOString()}
      where scope_key = ${SCOPE_KEY}
        and ${runnerInfrastructureReconciliations.nextAttemptAt} <= ${input.now.toISOString()}
        and (${runnerInfrastructureReconciliations.leaseExpiresAt} is null
          or ${runnerInfrastructureReconciliations.leaseExpiresAt} <= ${input.now.toISOString()})
      returning
        generation,
        lease_owner as "leaseOwner",
        lease_expires_at as "leaseExpiresAt"
    `);
    return claimed ?? null;
  });
}

async function releaseInfrastructure(
  connection: DatabaseConnection,
  claim: InfrastructureClaim,
  now: Date,
  retryMs = DEFAULT_RETRY_MS,
): Promise<void> {
  await connection.db.execute(sql`
    update ${runnerInfrastructureReconciliations}
    set generation = generation + 1,
        next_attempt_at = ${new Date(now.getTime() + retryMs).toISOString()},
        lease_owner = null,
        lease_expires_at = null,
        updated_at = ${now.toISOString()}
    where scope_key = ${SCOPE_KEY}
      and generation = ${claim.generation}
      and lease_owner = ${claim.leaseOwner}
      and lease_expires_at = ${dateIso(claim.leaseExpiresAt)}
  `);
}

async function readInventoryRunners(
  connection: DatabaseConnection,
  limit: number,
): Promise<InventoryRunner[]> {
  return await connection.db.execute<InventoryRunner>(sql`
    select
      ${runners.id} as id,
      ${runners.userId} as "userId",
      ${runners.status} as status,
      ${runners.compatibilityState} as "compatibilityState",
      ${runners.provisioningStatus} as "provisioningStatus",
      ${runners.provisioningOperationKey} as "provisioningOperationKey",
      ${runners.providerResourceId} as "providerResourceId",
      ${runners.deletedAt} as "deletedAt",
      count(${agents.id}) filter (where ${agents.deletedAt} is null)::int as "assignedCount"
    from ${runners}
    left join ${agents} on ${agents.runnerId} = ${runners.id}
    where ${runners.kind} = 'digitalocean'
      and ${runners.provider} = ${DIGITALOCEAN_PROVIDER}
      and ${runners.deletedAt} is null
    group by ${runners.id}
    order by ${runners.createdAt}, ${runners.id}
    limit ${limit}
  `);
}

async function clearOneStaleAssignment(
  connection: DatabaseConnection,
  now: Date,
): Promise<boolean> {
  return await connection.db.transaction(async (tx) => {
    const [stale] = await tx.execute<{ agentId: string; userId: string }>(sql`
      select ${agents.id} as "agentId", ${agents.userId} as "userId"
      from ${agents}
      inner join ${runners} on ${runners.id} = ${agents.runnerId}
      where ${agents.deletedAt} is null
        and ${runners.deletedAt} is not null
      order by ${agents.createdAt}, ${agents.id}
      for update of ${agents} skip locked
      limit 1
    `);
    if (!stale) return false;
    const [updated] = await tx
      .update(agents)
      .set({
        runnerId: null,
        status: "error",
        statusReason: "The assigned managed runner no longer exists.",
        updatedAt: now,
      })
      .where(and(eq(agents.id, stale.agentId), eq(agents.userId, stale.userId)))
      .returning({ id: agents.id });
    if (!updated) return false;
    await tx.insert(agentEvents).values({
      agentId: stale.agentId,
      actorUserId: stale.userId,
      type: "agent.runner_assignment_cleared",
      message: "Stale managed runner assignment cleared.",
      metadata: { reason: "runner_deleted" },
      createdAt: now,
    });
    return true;
  });
}

async function startMissingRunnerReplacement(
  connection: DatabaseConnection,
  runner: InventoryRunner,
  now: Date,
  dependencies: { randomUUID: () => string },
): Promise<boolean> {
  return await startRunnerReplacement(connection, runner, now, {
    ...dependencies,
    reason: "provider_resource_missing",
  });
}

async function startRunnerReplacement(
  connection: DatabaseConnection,
  runner: InventoryRunner,
  now: Date,
  dependencies: { randomUUID: () => string; reason: RunnerReplacementReason },
): Promise<boolean> {
  return await connection.db.transaction(async (tx) => {
    const [current] = await tx.execute<InventoryRunner>(sql`
      select
        ${runners.id} as id,
        ${runners.userId} as "userId",
        ${runners.status} as status,
        ${runners.compatibilityState} as "compatibilityState",
        ${runners.provisioningStatus} as "provisioningStatus",
        ${runners.provisioningOperationKey} as "provisioningOperationKey",
        ${runners.providerResourceId} as "providerResourceId",
        ${runners.deletedAt} as "deletedAt",
        (
          select count(*)::int
          from ${agents}
          where ${agents.runnerId} = ${runners.id}
            and ${agents.deletedAt} is null
        ) as "assignedCount"
      from ${runners}
      where ${runners.id} = ${runner.id}
        and ${runners.userId} = ${runner.userId}
        and ${runners.providerResourceId} is not distinct from ${runner.providerResourceId}
        and ${runners.deletedAt} is null
      for update
    `);
    if (!current || current.assignedCount < 1) return false;
    if (!isRunnerReplacementEligibleProvisioningStatus(current.provisioningStatus)) return false;
    if (
      dependencies.reason !== "provider_resource_missing" &&
      replacementReasonForUnhealthyRunner(current) !== dependencies.reason
    ) {
      return false;
    }

    const created = await createOrGetRunnerReplacement({
      db: tx,
      sourceRunnerId: current.id,
      triggerDeploymentId: null,
      reason: dependencies.reason,
      operationKey: `agentbay-replace-${dependencies.randomUUID().replaceAll("-", "")}`,
      now,
    });
    const [updated] = await tx
      .update(runners)
      .set({ status: "degraded", updatedAt: now })
      .where(
        and(
          eq(runners.id, current.id),
          eq(runners.userId, current.userId),
          eq(runners.providerResourceId, current.providerResourceId as string),
          isNull(runners.deletedAt),
        ),
      )
      .returning({ id: runners.id });
    return Boolean(updated && created.replacement.id);
  });
}

async function tombstoneUnassignedMissingRunner(
  connection: DatabaseConnection,
  runner: InventoryRunner,
  now: Date,
): Promise<boolean> {
  return await connection.db.transaction(async (tx) => {
    const [updated] = await tx.execute<{ id: string }>(sql`
      update ${runners}
      set status = 'deleted',
          provisioning_status = 'deleted',
          deleted_at = ${now.toISOString()},
          provisioning_completed_at = ${now.toISOString()},
          updated_at = ${now.toISOString()}
      where id = ${runner.id}
        and user_id = ${runner.userId}
        and provider_resource_id = ${runner.providerResourceId}
        and deleted_at is null
        and not exists (
          select 1 from ${agents}
          where ${agents.runnerId} = ${runner.id}
            and ${agents.deletedAt} is null
        )
      returning id
    `);
    if (!updated) return false;
    await tx
      .update(runnerCredentials)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(and(eq(runnerCredentials.runnerId, runner.id), isNull(runnerCredentials.revokedAt)));
    await tx
      .update(runnerRegistrationTokens)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(runnerRegistrationTokens.runnerId, runner.id),
          eq(runnerRegistrationTokens.status, "pending"),
        ),
      );
    return true;
  });
}

async function adoptInterruptedRunner(
  connection: DatabaseConnection,
  runner: InventoryRunner,
  resource: DigitalOceanResource,
  now: Date,
): Promise<boolean> {
  const [updated] = await connection.db
    .update(runners)
    .set({
      providerResourceId: resource.providerResourceId,
      providerFirewallId: resource.providerFirewallId,
      endpointUrl: resource.publicEndpointUrl ?? null,
      region: resource.region,
      sizeSlug: resource.sizeSlug,
      image: resource.image,
      status: "provisioning",
      provisioningStatus: resource.firewallApplied ? "waiting_for_runner" : "tagging",
      updatedAt: now,
    })
    .where(
      and(
        eq(runners.id, runner.id),
        eq(runners.userId, runner.userId),
        isNull(runners.providerResourceId),
        eq(runners.provisioningOperationKey, runner.provisioningOperationKey as string),
        isNull(runners.deletedAt),
      ),
    )
    .returning({ id: runners.id });
  return updated !== undefined;
}

async function reconcileOrphan(
  connection: DatabaseConnection,
  provider: DigitalOceanProvider,
  resource: DigitalOceanResource,
  now: Date,
  context: DigitalOceanProviderRequestContext,
  dependencies: { orphanGraceMs: number },
): Promise<RunnerInfrastructureReconcileResult> {
  const tag = operationTag(resource);
  if (!tag) return { processed: 1, outcome: "ambiguous_resource" };
  if (await hasActiveRunnerOwnership(connection, resource, tag)) {
    return { processed: 1, outcome: "exact_match" };
  }
  const [existing] = await connection.db
    .select()
    .from(runnerInfrastructureOrphans)
    .where(eq(runnerInfrastructureOrphans.providerResourceId, resource.providerResourceId))
    .limit(1);
  if (existing?.deletedAt) {
    return { processed: 1, outcome: "ambiguous_resource" };
  }
  if (
    existing &&
    (existing.operationTag !== tag ||
      existing.expectedName !== resource.name ||
      existing.expectedRegion !== resource.region ||
      existing.expectedSizeSlug !== resource.sizeSlug ||
      existing.providerFirewallId !== resource.providerFirewallId)
  ) {
    return { processed: 1, outcome: "ambiguous_resource" };
  }
  if (
    existing &&
    existing.deletedAt === null &&
    existing.observationCount >= 1 &&
    now.getTime() - new Date(existing.firstObservedAt).getTime() >= dependencies.orphanGraceMs &&
    resource.providerFirewallId
  ) {
    const owned = asOwnedSetProvider(provider);
    if (!owned) return { processed: 1, outcome: "ambiguous_resource" };
    const expectation = {
      operationTag: tag,
      providerResourceId: resource.providerResourceId,
      providerFirewallId: resource.providerFirewallId,
      expectedName: resource.name,
      expectedRegion: resource.region,
      expectedSizeSlug: resource.sizeSlug,
      expectedFirewallName: digitalOceanRunnerFirewallName(resource.providerResourceId),
    };
    const observed = await owned.observeOwnedSet(expectation, context);
    if (!observed.ok || observed.value.state !== "owned") {
      return { processed: 1, outcome: "ambiguous_resource" };
    }
    if (observed.value.firewall === "present") {
      const deleted = await owned.deleteFirewall(expectation, context);
      if (!deleted.ok) return { processed: 1, outcome: "provider_unavailable" };
    }
    if (observed.value.droplet === "present") {
      const deleted = await owned.deleteDroplet(expectation, context);
      if (!deleted.ok) return { processed: 1, outcome: "provider_unavailable" };
    }
    const absent = await owned.observeOwnedSet(expectation, context);
    if (!absent.ok || absent.value.state !== "absent") {
      return { processed: 1, outcome: "provider_unavailable" };
    }
    await connection.db
      .update(runnerInfrastructureOrphans)
      .set({
        observationCount: existing.observationCount + 1,
        lastObservedAt: now,
        deletedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(runnerInfrastructureOrphans.providerResourceId, resource.providerResourceId),
          isNull(runnerInfrastructureOrphans.deletedAt),
        ),
      );
    return { processed: 1, outcome: "orphan_deleted" };
  }

  await connection.db
    .insert(runnerInfrastructureOrphans)
    .values({
      providerResourceId: resource.providerResourceId,
      operationTag: tag,
      providerFirewallId: resource.providerFirewallId,
      expectedName: resource.name,
      expectedRegion: resource.region,
      expectedSizeSlug: resource.sizeSlug,
      firstObservedAt: now,
      lastObservedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: runnerInfrastructureOrphans.providerResourceId,
      set: {
        observationCount: sql`${runnerInfrastructureOrphans.observationCount} + 1`,
        lastObservedAt: now,
        updatedAt: now,
      },
    });
  return { processed: 1, outcome: "orphan_observed" };
}

function operationTag(resource: DigitalOceanResource): string | null {
  const tags = resource.tags.filter((tag) => OPERATION_TAG_PATTERN.test(tag));
  return tags.length === 1 ? (tags[0] ?? null) : null;
}

function isExactOwnedResource(
  resource: DigitalOceanResource,
  expectedOperationTag = operationTag(resource),
): boolean {
  return Boolean(
    expectedOperationTag &&
      OPERATION_TAG_PATTERN.test(expectedOperationTag) &&
      resource.name === expectedOperationTag &&
      resource.tags.includes(expectedOperationTag) &&
      resource.tags.includes(DIGITALOCEAN_MANAGED_RUNNER_TAG) &&
      resource.createdAt &&
      !Number.isNaN(new Date(resource.createdAt).getTime()),
  );
}

function replacementReasonForUnhealthyRunner(
  runner: InventoryRunner,
): RunnerReplacementReason | null {
  if (runner.provisioningStatus === "failed") return "boot_failure";
  if (!isRunnerReplacementEligibleProvisioningStatus(runner.provisioningStatus)) return null;
  if (runner.compatibilityState !== "compatible") return "release_mismatch";
  if (["offline", "degraded"].includes(runner.status)) return "stale_heartbeat";
  return null;
}

function isRunnerReplacementEligibleProvisioningStatus(status: string | null): boolean {
  return status === "ready" || status === "failed";
}

async function hasActiveRunnerOwnership(
  connection: DatabaseConnection,
  resource: DigitalOceanResource,
  operationTagValue: string,
): Promise<boolean> {
  const [owned] = await connection.db
    .select({ id: runners.id })
    .from(runners)
    .where(
      and(
        isNull(runners.deletedAt),
        sql`(${runners.providerResourceId} = ${resource.providerResourceId} OR ${runners.provisioningOperationKey} = ${operationTagValue})`,
      ),
    )
    .limit(1);
  return owned !== undefined;
}

function asOwnedSetProvider(provider: DigitalOceanProvider): DigitalOceanOwnedSetProvider | null {
  const candidate = provider as Partial<DigitalOceanOwnedSetProvider>;
  return typeof candidate.observeOwnedSet === "function" &&
    typeof candidate.deleteFirewall === "function" &&
    typeof candidate.deleteDroplet === "function"
    ? (candidate as DigitalOceanOwnedSetProvider)
    : null;
}

function normalizeLimit(value: number | undefined): number {
  return Number.isInteger(value) && Number(value) > 0
    ? Math.min(Number(value), DEFAULT_INVENTORY_LIMIT)
    : DEFAULT_INVENTORY_LIMIT;
}

function dateIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function providerDeadline(timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS): {
  context: DigitalOceanProviderRequestContext;
  clear: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { context: { signal: controller.signal }, clear: () => clearTimeout(timeout) };
}
