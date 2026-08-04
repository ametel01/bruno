import "server-only";

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { RUNNER_BOOT_CONTRACT_VERSION } from "@/src/runner-service/constants";
import { parseImmutableRunnerImageReference } from "@/src/runner-service/release-identity";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agents,
  runnerCredentials,
  runnerHeartbeats,
  runnerRegistrationTokens,
  runners,
} from "@/src/server/db/schema";
import { type DigitalOceanProviderConfig, readDigitalOceanProviderConfig } from "@/src/server/env";
import {
  DIGITALOCEAN_PROVIDER,
  type DigitalOceanOwnedSetProvider,
  type DigitalOceanProvider,
  type DigitalOceanProviderRequestContext,
} from "@/src/server/runners/digitalocean-provider";
import {
  type RunnerCompatibilityRequirement,
  requiredRunnerImageDigestForProvider,
} from "@/src/server/runners/runner-compatibility";
import {
  confirmCloudRunnerReadiness,
  RUNNER_HEARTBEAT_STALE_THRESHOLD_MS,
} from "@/src/server/runners/runner-heartbeat";
import {
  advanceAutomaticDigitalOceanRunnerProvisioning,
  createConfiguredDigitalOceanProvider,
  digitalOceanRunnerFirewallName,
} from "@/src/server/runners/runner-provisioning";
import {
  applyClaimedRunnerReplacementTransition,
  type ClaimedRunnerReplacement,
  claimNextRunnerReplacement,
  reserveClaimedRunnerReplacementBudget,
} from "@/src/server/runners/runner-replacement-store";

const DEFAULT_RETRY_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
const REPLACEMENT_TARGET_STATES = new Set(["pending", "provisioning_target", "validating_target"]);

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
  retryMs?: number;
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
    if (!REPLACEMENT_TARGET_STATES.has(claim.state)) {
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
      .select({ userId: runners.userId, name: runners.name })
      .from(runners)
      .where(
        and(
          eq(runners.id, claim.sourceRunnerId),
          eq(runners.kind, "digitalocean"),
          eq(runners.provider, DIGITALOCEAN_PROVIDER),
          isNull(runners.deletedAt),
        ),
      )
      .limit(1);
    if (!source) throw new Error("Replacement source is unavailable.");

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
    return await failClaim(input.connection, input.claim, input.now, input.terminalCode);
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
      .where(eq(runnerRegistrationTokens.runnerId, target.id));
    await tx
      .update(runnerCredentials)
      .set({ revokedAt: input.now, updatedAt: input.now })
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
  code: "target_provisioning_failed" | "target_validation_failed" | "state_invalid",
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
