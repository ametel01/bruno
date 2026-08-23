import "server-only";

import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { DatabaseConnection } from "@/src/server/db/client";
import {
  founderInfrastructureRetirements,
  founderRecoveryArchives,
  operatorRuntimes,
  operators,
  runnerCredentials,
  runners,
} from "@/src/server/db/schema";
import type {
  DigitalOceanOwnedSetExpectation,
  DigitalOceanOwnedSetObservation,
  DigitalOceanOwnedSetProvider,
  DigitalOceanOwnedSetResult,
} from "@/src/server/runners/digitalocean-provider";
import { digitalOceanRunnerFirewallName } from "@/src/server/runners/runner-provisioning";
import { founderProductContractDigest } from "./digest";
import { requireRetirementDue } from "./entitlement";
import {
  lockFounderProductContractLifecycleInTransaction,
  requireActiveFounderOperatorAuthorityInTransaction,
} from "./operator-authority";
import {
  fulfillRecoveryArchiveIntent,
  persistFounderRecoveryArchiveIntentInTransaction,
} from "./recovery-archive";
import type { FounderRecoveryArchiveProvider } from "./recovery-archive-provider";

const RETIREMENT_LEASE_MILLISECONDS = 5 * 60 * 1_000;
const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const RETIREMENT_PAUSE_REASON = "Infrastructure retirement in progress.";

export type FounderInfrastructureRetirementProvider = FounderRecoveryArchiveProvider & {
  digitalOcean: DigitalOceanOwnedSetProvider;
  calls(): readonly string[];
};

export type FounderInfrastructureRetirementInput = {
  action: "infrastructure_retirement";
  runId: string;
  userId: string;
  now: Date;
};

export type FounderInfrastructureRetirementCleanup = {
  resourcesBefore: number;
  resourcesAfter: number;
  verified: boolean;
  observedAt: string;
};

export type FounderInfrastructureRetirementStatusDto =
  | { state: "unavailable" }
  | {
      state: "in_progress" | "completed";
      receiptId: string;
      attemptCount: number;
      hardDestructionDueAt: string;
      workStoppedAt: string;
      credentialsDisabledAt: string;
      archive: {
        outcome: "pending" | "verified" | "failed";
        criticalFailure: boolean;
      };
      exactResource: {
        provider: "digitalocean";
        dropletId: string;
        firewallId: string;
      };
      provider: {
        droplet: "unknown" | "present" | "absent";
        firewall: "unknown" | "present" | "absent";
        lastCheckedAt: string | null;
        absenceVerifiedAt: string | null;
      };
      billableRuntime: {
        startedAt: string | null;
        endedAt: string | null;
        seconds: number | null;
      };
      needsAttention: boolean;
    };

type RetirementDependencies = {
  providers: FounderInfrastructureRetirementProvider;
  applicationRevision: string;
  providerRequestTimeoutMilliseconds?: number;
};

type RetirementWork = {
  receiptId: string;
  leaseToken: string;
  runnerId: string;
  operatorId: string;
  runtimeRevision: string;
  recoveryArchiveId: string;
  archiveNeedsExecution: boolean;
  expectation: DigitalOceanOwnedSetExpectation;
  resourcesBefore: number;
  providerResourceCreatedAt: Date | null;
};

export async function executeFounderInfrastructureRetirement(
  input: FounderInfrastructureRetirementInput,
  dependencies: RetirementDependencies,
  connection: DatabaseConnection,
): Promise<FounderInfrastructureRetirementCleanup> {
  const prepared = await prepareFounderInfrastructureRetirement(input, dependencies, connection);
  if ("cleanup" in prepared) return prepared.cleanup;

  try {
    const archiveOutcome = await attemptBoundedRecoveryArchive(
      input,
      prepared,
      dependencies,
      connection,
    );
    const observedResult = await runProviderStep(
      "observe_owned_resources",
      (signal) =>
        dependencies.providers.digitalOcean.observeOwnedSet(prepared.expectation, { signal }),
      dependencies.providerRequestTimeoutMilliseconds,
    );
    assertOwnedSetObservation(observedResult);
    let observation = observedResult.value;
    let providerResourceCreatedAt = requireProviderCostOrigin(
      observation,
      prepared.providerResourceCreatedAt,
    );
    await recordProviderObservation(
      input,
      prepared,
      observation,
      providerResourceCreatedAt,
      connection,
    );
    if (observation.firewall === "present") {
      const firewall = await runProviderStep(
        "delete_firewall",
        (signal) =>
          dependencies.providers.digitalOcean.deleteFirewall(prepared.expectation, { signal }),
        dependencies.providerRequestTimeoutMilliseconds,
      );
      if (!firewall.ok) throw retirementProviderError(firewall);
      observation = { ...observation, firewall: "absent" };
      await recordProviderObservation(
        input,
        prepared,
        observation,
        providerResourceCreatedAt,
        connection,
      );
    }

    if (observation.droplet === "present") {
      const droplet = await runProviderStep(
        "delete_droplet",
        (signal) =>
          dependencies.providers.digitalOcean.deleteDroplet(prepared.expectation, { signal }),
        dependencies.providerRequestTimeoutMilliseconds,
      );
      if (!droplet.ok) throw retirementProviderError(droplet);
      observation = { ...observation, droplet: "absent", dropletCreatedAt: null };
      await recordProviderObservation(
        input,
        prepared,
        observation,
        providerResourceCreatedAt,
        connection,
      );
    }

    const afterResult = await runProviderStep(
      "observe_owned_resources_absent",
      (signal) =>
        dependencies.providers.digitalOcean.observeOwnedSet(prepared.expectation, { signal }),
      dependencies.providerRequestTimeoutMilliseconds,
    );
    assertOwnedSetObservation(afterResult);
    const after = afterResult.value;
    if (after.state !== "absent" || after.droplet !== "absent" || after.firewall !== "absent") {
      throw new RetirementFailure(
        "provider_absence_unverified",
        "DigitalOcean resource absence was not verified.",
      );
    }
    providerResourceCreatedAt = requireProviderCostOrigin(after, providerResourceCreatedAt);
    await recordProviderObservation(input, prepared, after, providerResourceCreatedAt, connection);
    await completeFounderInfrastructureRetirement(
      input,
      prepared,
      providerResourceCreatedAt,
      archiveOutcome,
      connection,
    );
  } catch (error) {
    await retainFounderInfrastructureRetirementFailure(input, prepared, error, connection);
    throw error;
  }

  return {
    resourcesBefore: prepared.resourcesBefore,
    resourcesAfter: 0,
    verified: true,
    observedAt: input.now.toISOString(),
  };
}

export async function getFounderInfrastructureRetirementStatusForUser(
  userId: string,
  dependencies: { createConnection?: () => DatabaseConnection } = {},
): Promise<FounderInfrastructureRetirementStatusDto> {
  const connection =
    dependencies.createConnection?.() ??
    (await import("@/src/server/db/client")).createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const [receipt] = await connection.db
      .select()
      .from(founderInfrastructureRetirements)
      .where(eq(founderInfrastructureRetirements.userId, userId))
      .orderBy(desc(founderInfrastructureRetirements.updatedAt))
      .limit(1);
    if (
      !receipt?.hardDestructionDueAt ||
      !receipt.workStoppedAt ||
      !receipt.credentialsDisabledAt
    ) {
      return { state: "unavailable" };
    }
    return {
      state: receipt.status === "completed" ? "completed" : "in_progress",
      receiptId: receipt.id,
      attemptCount: receipt.attemptCount,
      hardDestructionDueAt: receipt.hardDestructionDueAt.toISOString(),
      workStoppedAt: receipt.workStoppedAt.toISOString(),
      credentialsDisabledAt: receipt.credentialsDisabledAt.toISOString(),
      archive: {
        outcome: receipt.archiveOutcome as "pending" | "verified" | "failed",
        criticalFailure: receipt.archiveOutcome === "failed",
      },
      exactResource: {
        provider: "digitalocean",
        dropletId: receipt.providerResourceId,
        firewallId: receipt.providerFirewallId,
      },
      provider: {
        droplet: receipt.providerDropletState as "unknown" | "present" | "absent",
        firewall: receipt.providerFirewallState as "unknown" | "present" | "absent",
        lastCheckedAt: receipt.providerObservedAt?.toISOString() ?? null,
        absenceVerifiedAt: receipt.absenceVerifiedAt?.toISOString() ?? null,
      },
      billableRuntime: {
        startedAt: receipt.providerResourceCreatedAt?.toISOString() ?? null,
        endedAt: receipt.absenceVerifiedAt?.toISOString() ?? null,
        seconds: receipt.billableRuntimeSeconds,
      },
      needsAttention: receipt.status !== "completed" && receipt.failureCode !== null,
    };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

async function prepareFounderInfrastructureRetirement(
  input: FounderInfrastructureRetirementInput,
  dependencies: RetirementDependencies,
  connection: DatabaseConnection,
): Promise<RetirementWork | { cleanup: FounderInfrastructureRetirementCleanup }> {
  return connection.db.transaction(async (tx) => {
    await lockFounderProductContractLifecycleInTransaction(tx, input.userId);
    const { operatorId } = await requireActiveFounderOperatorAuthorityInTransaction(
      tx,
      input.userId,
    );
    const [runtime] = await tx
      .select({
        configRevision: operatorRuntimes.configRevision,
        runtimeIdentity: operatorRuntimes.runtimeIdentity,
      })
      .from(operatorRuntimes)
      .where(eq(operatorRuntimes.operatorId, operatorId))
      .orderBy(desc(operatorRuntimes.updatedAt))
      .limit(1);
    if (!runtime?.configRevision) {
      throw new Error("Infrastructure Retirement requires a persisted runtime revision.");
    }
    const hardDestructionDueAt = await requireRetirementDue(tx, input.userId, input.now);

    const existingCandidates = await tx
      .select()
      .from(founderInfrastructureRetirements)
      .where(eq(founderInfrastructureRetirements.userId, input.userId))
      .orderBy(desc(founderInfrastructureRetirements.updatedAt))
      .limit(2)
      .for("update");
    const activeExisting = existingCandidates.filter(
      (candidate) => candidate.status !== "completed",
    );
    if (activeExisting.length > 1) {
      throw new Error("Infrastructure Retirement receipt identity is ambiguous.");
    }
    const existing =
      activeExisting[0] ?? existingCandidates.find((candidate) => candidate.status === "completed");
    if (existing?.status === "completed" && existing.absenceVerifiedAt) {
      return {
        cleanup: {
          resourcesBefore: existing.resourcesBefore,
          resourcesAfter: 0,
          verified: true,
          observedAt: existing.absenceVerifiedAt.toISOString(),
        },
      };
    }
    if (existing && existing.leaseExpiresAt > input.now) {
      throw new Error("Infrastructure Retirement is already in progress.");
    }

    const runnerCandidates = existing
      ? await tx
          .select()
          .from(runners)
          .where(eq(runners.id, existing.runnerId))
          .limit(1)
          .for("update")
      : await tx
          .select()
          .from(runners)
          .where(
            and(
              eq(runners.userId, input.userId),
              eq(runners.kind, "digitalocean"),
              eq(runners.provider, "digitalocean"),
            ),
          )
          .limit(2)
          .for("update");
    if (runnerCandidates.length > 1) {
      throw new Error("Infrastructure Retirement runner identity is ambiguous.");
    }
    const [runner] = runnerCandidates;
    if (!runner) throw new Error("An exactly identified DigitalOcean runner is required.");

    const expectation = existing ? expectationFromReceipt(existing) : expectationFromRunner(runner);
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(input.now.valueOf() + RETIREMENT_LEASE_MILLISECONDS);
    let recoveryArchiveId = existing?.recoveryArchiveId ?? null;
    let archiveNeedsExecution = false;
    let archiveRuntimeRevision = runtime.configRevision;

    if (existing) {
      if (!recoveryArchiveId) {
        throw new Error("Infrastructure Retirement is missing its Recovery Archive intent.");
      }
      const [archive] = await tx
        .select({
          status: founderRecoveryArchives.status,
          applicationRevision: founderRecoveryArchives.applicationRevision,
          runtimeRevision: founderRecoveryArchives.runtimeRevision,
        })
        .from(founderRecoveryArchives)
        .where(eq(founderRecoveryArchives.id, recoveryArchiveId))
        .limit(1);
      if (!archive) throw new Error("Infrastructure Retirement Recovery Archive is missing.");
      if (
        archive.status === "pending" &&
        archive.applicationRevision !== dependencies.applicationRevision
      ) {
        await tx
          .update(founderRecoveryArchives)
          .set({ status: "failed", failureCode: "archive_application_revision_mismatch" })
          .where(eq(founderRecoveryArchives.id, recoveryArchiveId));
      } else if (archive.status === "pending" && !archive.runtimeRevision) {
        await tx
          .update(founderRecoveryArchives)
          .set({ status: "failed", failureCode: "archive_runtime_revision_unavailable" })
          .where(eq(founderRecoveryArchives.id, recoveryArchiveId));
      } else {
        archiveNeedsExecution = archive.status === "pending";
        archiveRuntimeRevision = archive.runtimeRevision ?? runtime.configRevision;
      }
      await tx
        .update(founderInfrastructureRetirements)
        .set({
          leaseToken,
          leaseExpiresAt,
          failureCode: null,
          attemptCount: existing.attemptCount + 1,
          updatedAt: input.now,
        })
        .where(eq(founderInfrastructureRetirements.id, existing.id));
    } else {
      recoveryArchiveId = await persistFounderRecoveryArchiveIntentInTransaction(tx, {
        userId: input.userId,
        operatorId,
        applicationRevision: dependencies.applicationRevision,
        runtimeRevision: runtime.configRevision,
        now: input.now,
        pendingIntentPolicy: "supersede_for_retirement",
      });
      archiveNeedsExecution = true;
      await tx.insert(founderInfrastructureRetirements).values({
        userId: input.userId,
        runnerId: runner.id,
        recoveryArchiveId,
        idempotencyKey: founderProductContractDigest(`${input.userId}:${runner.id}`),
        providerResourceId: expectation.providerResourceId,
        providerFirewallId: expectation.providerFirewallId,
        providerOperationTag: expectation.operationTag,
        providerResourceName: expectation.expectedName,
        providerRegion: expectation.expectedRegion,
        providerSizeSlug: expectation.expectedSizeSlug,
        providerFirewallName: expectation.expectedFirewallName,
        retiredRuntimeIdentity: runtime.runtimeIdentity,
        hardDestructionDueAt,
        status: "in_progress",
        resourcesBefore: 0,
        resourcesAfter: null,
        providerDropletState: "unknown",
        providerFirewallState: "unknown",
        workStoppedAt: input.now,
        credentialsDisabledAt: input.now,
        archiveOutcome: "pending",
        failureCode: null,
        attemptCount: 1,
        leaseToken,
        leaseExpiresAt,
        createdAt: input.now,
        updatedAt: input.now,
      });
      await tx
        .update(operators)
        .set({
          externalActionPause: true,
          externalActionPauseReason: RETIREMENT_PAUSE_REASON,
          externalActionPausedAt: input.now,
          updatedAt: input.now,
        })
        .where(eq(operators.id, operatorId));
      await tx
        .update(runnerCredentials)
        .set({ status: "revoked", revokedAt: input.now, updatedAt: input.now })
        .where(
          and(eq(runnerCredentials.runnerId, runner.id), eq(runnerCredentials.status, "active")),
        );
    }

    const [receipt] = await tx
      .select()
      .from(founderInfrastructureRetirements)
      .where(eq(founderInfrastructureRetirements.runnerId, runner.id))
      .limit(1);
    if (!receipt || !recoveryArchiveId) {
      throw new Error("Infrastructure Retirement receipt was not persisted.");
    }
    return {
      receiptId: receipt.id,
      leaseToken,
      runnerId: runner.id,
      operatorId,
      runtimeRevision: archiveRuntimeRevision,
      recoveryArchiveId,
      archiveNeedsExecution,
      expectation,
      resourcesBefore: receipt.resourcesBefore,
      providerResourceCreatedAt: receipt.providerResourceCreatedAt,
    };
  });
}

async function attemptBoundedRecoveryArchive(
  input: FounderInfrastructureRetirementInput,
  work: RetirementWork,
  dependencies: RetirementDependencies,
  connection: DatabaseConnection,
): Promise<{ outcome: "verified" | "failed"; failureCode: string | null }> {
  if (work.archiveNeedsExecution) {
    const attempt = fulfillRecoveryArchiveIntent(
      { ...input, applicationRevision: dependencies.applicationRevision },
      dependencies.providers,
      connection,
      work.recoveryArchiveId,
      work.operatorId,
      false,
      () => input.now,
      work.runtimeRevision,
    );
    const completed = await waitForBoundedArchiveAttempt(
      attempt,
      dependencies.providerRequestTimeoutMilliseconds,
    );
    if (!completed) {
      await connection.db
        .update(founderRecoveryArchives)
        .set({ status: "failed", failureCode: "archive_create_timeout" })
        .where(
          and(
            eq(founderRecoveryArchives.id, work.recoveryArchiveId),
            eq(founderRecoveryArchives.status, "pending"),
          ),
        );
      // A late publication observes the non-pending intent and enters the archive module's
      // rejected-publication cleanup path. Its completion cannot delay infrastructure destruction.
      void attempt.catch(() => undefined);
    }
  }
  const outcome = await readArchiveOutcome(work.recoveryArchiveId, connection);
  await recordArchiveOutcome(work.receiptId, work.leaseToken, outcome, input.now, connection);
  return outcome;
}

async function waitForBoundedArchiveAttempt(
  attempt: Promise<void>,
  configuredTimeout?: number,
): Promise<boolean> {
  const timeout = providerRequestTimeout(configuredTimeout);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      attempt.then(() => true),
      new Promise<false>((resolve) => {
        timeoutId = setTimeout(() => resolve(false), timeout);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function expectationFromRunner(
  runner: typeof runners.$inferSelect,
): DigitalOceanOwnedSetExpectation {
  if (
    !runner.providerResourceId ||
    !runner.providerFirewallId ||
    !runner.region ||
    !runner.sizeSlug ||
    !runner.provisioningOperationKey
  ) {
    throw new Error("An exactly identified DigitalOcean runner is required.");
  }
  return {
    operationTag: runner.provisioningOperationKey,
    providerResourceId: runner.providerResourceId,
    providerFirewallId: runner.providerFirewallId,
    expectedName: runner.name,
    expectedRegion: runner.region,
    expectedSizeSlug: runner.sizeSlug,
    expectedFirewallName: digitalOceanRunnerFirewallName(runner.providerResourceId),
  };
}

function expectationFromReceipt(
  receipt: typeof founderInfrastructureRetirements.$inferSelect,
): DigitalOceanOwnedSetExpectation {
  if (
    !receipt.providerOperationTag ||
    !receipt.providerResourceName ||
    !receipt.providerRegion ||
    !receipt.providerSizeSlug ||
    !receipt.providerFirewallName ||
    !receipt.hardDestructionDueAt
  ) {
    throw new Error("Infrastructure Retirement persisted identity is incomplete.");
  }
  return {
    operationTag: receipt.providerOperationTag,
    providerResourceId: receipt.providerResourceId,
    providerFirewallId: receipt.providerFirewallId,
    expectedName: receipt.providerResourceName,
    expectedRegion: receipt.providerRegion,
    expectedSizeSlug: receipt.providerSizeSlug,
    expectedFirewallName: receipt.providerFirewallName,
  };
}

async function recordProviderObservation(
  input: FounderInfrastructureRetirementInput,
  work: RetirementWork,
  observation: DigitalOceanOwnedSetObservation,
  providerResourceCreatedAt: Date,
  connection: DatabaseConnection,
): Promise<void> {
  const resourcesAfter =
    Number(observation.droplet === "present") + Number(observation.firewall === "present");
  await connection.db
    .update(founderInfrastructureRetirements)
    .set({
      resourcesBefore: Math.max(work.resourcesBefore, resourcesAfter),
      resourcesAfter,
      providerResourceCreatedAt,
      providerDropletState: observation.droplet,
      providerFirewallState: observation.firewall,
      providerObservedAt: input.now,
      ...(observation.firewall === "absent" ? { firewallDeletedAt: input.now } : {}),
      ...(observation.droplet === "absent" ? { dropletDeletedAt: input.now } : {}),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(founderInfrastructureRetirements.id, work.receiptId),
        eq(founderInfrastructureRetirements.leaseToken, work.leaseToken),
        eq(founderInfrastructureRetirements.status, "in_progress"),
      ),
    );
  work.resourcesBefore = Math.max(work.resourcesBefore, resourcesAfter);
}

async function completeFounderInfrastructureRetirement(
  input: FounderInfrastructureRetirementInput,
  work: RetirementWork,
  providerResourceCreatedAt: Date,
  archive: { outcome: "verified" | "failed"; failureCode: string | null },
  connection: DatabaseConnection,
): Promise<void> {
  await connection.db.transaction(async (tx) => {
    await lockFounderProductContractLifecycleInTransaction(tx, input.userId);
    const [receipt] = await tx
      .select({ leaseToken: founderInfrastructureRetirements.leaseToken })
      .from(founderInfrastructureRetirements)
      .where(eq(founderInfrastructureRetirements.id, work.receiptId))
      .limit(1)
      .for("update");
    if (receipt?.leaseToken !== work.leaseToken) {
      throw new Error("Infrastructure Retirement lease ownership changed.");
    }
    const billableRuntimeSeconds = Math.max(
      0,
      Math.ceil((input.now.valueOf() - providerResourceCreatedAt.valueOf()) / 1_000),
    );
    await tx
      .update(runners)
      .set({
        status: "deleted",
        provisioningStatus: "deleted",
        deletedAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(runners.id, work.runnerId));
    await tx
      .update(operatorRuntimes)
      .set({
        status: "needs_attention",
        transportState: "failed",
        safetyState: "unknown",
        runtimeIdentity: null,
        operationId: null,
        readyAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        recoveryMessage:
          "Bruno must verify newly provisioned infrastructure before work can resume.",
        failureCode: "infrastructure_retired",
        updatedAt: input.now,
      })
      .where(eq(operatorRuntimes.operatorId, work.operatorId));
    await tx
      .update(founderInfrastructureRetirements)
      .set({
        status: "completed",
        resourcesAfter: 0,
        providerDropletState: "absent",
        providerFirewallState: "absent",
        providerObservedAt: input.now,
        providerResourceCreatedAt,
        archiveOutcome: archive.outcome,
        archiveFailureCode: archive.failureCode,
        firewallDeletedAt: input.now,
        dropletDeletedAt: input.now,
        absenceVerifiedAt: input.now,
        billableRuntimeSeconds,
        failureCode: null,
        leaseExpiresAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(founderInfrastructureRetirements.id, work.receiptId));
  });
}

async function readArchiveOutcome(
  archiveId: string,
  connection: DatabaseConnection,
): Promise<{ outcome: "verified" | "failed"; failureCode: string | null }> {
  const [archive] = await connection.db
    .select({
      status: founderRecoveryArchives.status,
      failureCode: founderRecoveryArchives.failureCode,
    })
    .from(founderRecoveryArchives)
    .where(eq(founderRecoveryArchives.id, archiveId))
    .limit(1);
  if (archive?.status === "verified") return { outcome: "verified", failureCode: null };
  if (archive?.status === "failed") {
    return { outcome: "failed", failureCode: archive.failureCode ?? "archive_preservation_failed" };
  }
  throw new RetirementFailure(
    "archive_outcome_unresolved",
    "Infrastructure Retirement Recovery Archive outcome is unresolved.",
  );
}

async function recordArchiveOutcome(
  receiptId: string,
  leaseToken: string,
  archive: { outcome: "verified" | "failed"; failureCode: string | null },
  now: Date,
  connection: DatabaseConnection,
): Promise<void> {
  await connection.db
    .update(founderInfrastructureRetirements)
    .set({
      archiveOutcome: archive.outcome,
      archiveFailureCode: archive.failureCode,
      updatedAt: now,
    })
    .where(
      and(
        eq(founderInfrastructureRetirements.id, receiptId),
        eq(founderInfrastructureRetirements.leaseToken, leaseToken),
        eq(founderInfrastructureRetirements.status, "in_progress"),
      ),
    );
}

async function retainFounderInfrastructureRetirementFailure(
  input: FounderInfrastructureRetirementInput,
  work: RetirementWork,
  error: unknown,
  connection: DatabaseConnection,
): Promise<void> {
  await connection.db
    .update(founderInfrastructureRetirements)
    .set({
      failureCode: error instanceof RetirementFailure ? error.code : "retirement_attempt_failed",
      leaseExpiresAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(founderInfrastructureRetirements.id, work.receiptId),
        eq(founderInfrastructureRetirements.leaseToken, work.leaseToken),
        eq(founderInfrastructureRetirements.status, "in_progress"),
      ),
    );
}

function assertOwnedSetObservation(
  result: DigitalOceanOwnedSetResult<DigitalOceanOwnedSetObservation>,
): asserts result is { ok: true; value: DigitalOceanOwnedSetObservation } {
  if (!result.ok) throw retirementProviderError(result);
}

function requireProviderCostOrigin(
  observation: DigitalOceanOwnedSetObservation,
  persisted: Date | null,
): Date {
  if (observation.droplet === "absent") {
    if (persisted) return persisted;
    throw new RetirementFailure(
      "provider_cost_origin_unavailable",
      "DigitalOcean creation time was not recorded before Droplet absence.",
    );
  }
  const observed = observation.dropletCreatedAt ? new Date(observation.dropletCreatedAt) : null;
  if (
    !observed ||
    Number.isNaN(observed.valueOf()) ||
    observed.toISOString() !== observation.dropletCreatedAt
  ) {
    throw new RetirementFailure(
      "provider_cost_origin_unavailable",
      "DigitalOcean did not provide an authoritative Droplet creation time.",
    );
  }
  if (persisted && persisted.valueOf() !== observed.valueOf()) {
    throw new RetirementFailure(
      "provider_identity_ambiguous",
      "DigitalOcean Droplet creation identity changed during retirement.",
    );
  }
  return observed;
}

function retirementProviderError(result: {
  ok: false;
  reason: string;
  message: string;
}): RetirementFailure {
  return new RetirementFailure(`digitalocean_${result.reason}`, result.message);
}

async function runProviderStep<T>(
  operation: string,
  run: (signal: AbortSignal) => Promise<T>,
  configuredTimeout?: number,
): Promise<T> {
  const timeout = providerRequestTimeout(configuredTimeout);
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(
            new RetirementFailure(
              "provider_request_timeout",
              `Infrastructure Retirement provider operation ${operation} timed out.`,
            ),
          );
        }, timeout);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function providerRequestTimeout(configuredTimeout?: number): number {
  const timeout = configuredTimeout ?? DEFAULT_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error("Infrastructure Retirement provider timeout must be a positive integer.");
  }
  return timeout;
}

class RetirementFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RetirementFailure";
  }
}
