import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderInfrastructureRetirements,
  founderRecoveryArchives,
  founderReleaseDecisions,
  operatorRuntimes,
  operators,
  runnerCredentials,
  runners,
} from "@/src/server/db/schema";
import type {
  DigitalOceanOwnedSetExpectation,
  DigitalOceanOwnedSetProvider,
} from "@/src/server/runners/digitalocean-provider";
import { digitalOceanRunnerFirewallName } from "@/src/server/runners/runner-provisioning";
import { expireFounderRecoveryArchivesForUser } from "./archive-expiry";
import { founderProductContractDigest } from "./digest";
import { reconcileFounderCommerceEvent, requireRetirementDue } from "./entitlement";
import {
  lockFounderProductContractLifecycleInTransaction,
  requireActiveFounderOperatorAuthorityInTransaction,
  requireReadyFounderOperatorAuthorityInTransaction,
} from "./operator-authority";
import { persistQualifiedFounderOwnerPreviewAdmissionInTransaction } from "./owner-preview-admission";
import { FOUNDER_PREVIEW_QUALIFICATION_MAX_AGE_MS } from "./preview-qualification";
import {
  createDurableRecoveryArchive,
  fulfillRecoveryArchiveIntent,
  persistFounderRecoveryArchiveIntentInTransaction,
} from "./recovery-archive";
import type { FounderRecoveryArchiveProvider } from "./recovery-archive-provider";

export type FounderProductContractLifecycleAction =
  | "release_stage_admission"
  | "product_entitlement_lifecycle"
  | "recovery_archive_lifecycle"
  | "infrastructure_retirement";

export type FounderCommerceEvent = {
  eventId: string;
  checkoutCorrelation: string;
  subscriptionId: string;
  status: FounderCommerceStatus;
  endsAt: string | null;
  occurredAt: string;
  signature: string;
};

export type FounderCommerceStatus =
  | "active"
  | "past_due"
  | "unpaid"
  | "cancelled"
  | "expired"
  | "refunded";

export type FounderLifecycleProviderBoundary = FounderRecoveryArchiveProvider & {
  authenticateIdentity(input: { userId: string }): Promise<{ subject: string }>;
  verifyCapabilityProviders(): Promise<{
    openAI: true;
    anthropic: true;
    google: true;
  }>;
  readSubscription(input: { subscriptionId: string }): Promise<{ status: FounderCommerceStatus }>;
  digitalOcean: DigitalOceanOwnedSetProvider;
  calls(): readonly string[];
};

export type FounderLifecycleCleanup = {
  resourcesBefore: number;
  resourcesAfter: number;
  verified: boolean;
  observedAt: string;
};

export type FounderLifecycleOutcome = {
  action: FounderProductContractLifecycleAction;
  status: "passed";
  observedAt: string;
  providerCalls: readonly string[];
  cleanup: FounderLifecycleCleanup;
};

type LifecycleInput = {
  action: FounderProductContractLifecycleAction;
  runId: string;
  userId: string;
  now: Date;
  commerceEvent?: FounderCommerceEvent;
};

type LifecycleDependencies = {
  providers: FounderLifecycleProviderBoundary;
  commerceWebhookSecret: string;
  applicationRevision: string;
  createConnection?: () => DatabaseConnection;
};

export async function executeFounderProductContractLifecycleAction(
  input: LifecycleInput,
  dependencies: LifecycleDependencies,
): Promise<FounderLifecycleOutcome> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    if (input.action !== "infrastructure_retirement") {
      await expireFounderRecoveryArchivesForUser(
        input.userId,
        input.now,
        dependencies.providers,
        connection,
      );
    }
    if (input.action === "infrastructure_retirement") {
      await connection.db.transaction(async (tx) => {
        await lockFounderProductContractLifecycleInTransaction(tx, input.userId);
        await reconcileFounderCommerceEvent(tx, input, dependencies);
      });
      return await executeInfrastructureRetirement(input, dependencies, connection);
    }
    const lifecycleArchiveId =
      input.action === "release_stage_admission" || input.action === "recovery_archive_lifecycle"
        ? await createDurableRecoveryArchive(
            { ...input, applicationRevision: dependencies.applicationRevision },
            dependencies.providers,
            connection,
            () => input.now,
          )
        : null;
    return await connection.db.transaction(async (tx) => {
      const { operatorId, runtimeRevision } =
        await requireReadyFounderOperatorAuthorityInTransaction(tx, input.userId);

      const cleanup = emptyCleanup(input.now);
      switch (input.action) {
        case "release_stage_admission": {
          const identity = await dependencies.providers.authenticateIdentity({
            userId: input.userId,
          });
          if (!identity.subject) throw new Error("Clerk identity authentication was inconclusive.");
          const capabilities = await dependencies.providers.verifyCapabilityProviders();
          if (!capabilities.openAI || !capabilities.google) {
            throw new Error("Owner Preview provider qualification was inconclusive.");
          }
          if (!lifecycleArchiveId) throw new Error("A verified Recovery Archive is required.");
          const qualificationEvidenceDigests = [
            founderProductContractDigest(
              JSON.stringify({ capability: "openai", qualifiedAt: input.now.toISOString() }),
            ),
            founderProductContractDigest(
              JSON.stringify({
                capability: "calendar_reading",
                qualifiedAt: input.now.toISOString(),
              }),
            ),
          ];
          await persistQualifiedFounderOwnerPreviewAdmissionInTransaction(tx, {
            userId: input.userId,
            operatorId,
            applicationRevision: dependencies.applicationRevision,
            runtimeRevision,
            identityKind: "clerk",
            identitySubject: identity.subject,
            qualificationEvidenceDigests,
            freshQualificationEvidenceDigests: qualificationEvidenceDigests,
            qualificationObservedAt: input.now,
            qualificationExpiresAt: {
              openai: new Date(input.now.valueOf() + FOUNDER_PREVIEW_QUALIFICATION_MAX_AGE_MS),
              calendar_reading: new Date(
                input.now.valueOf() + FOUNDER_PREVIEW_QUALIFICATION_MAX_AGE_MS,
              ),
            },
            recoveryArchiveId: lifecycleArchiveId,
            now: input.now,
          });
          break;
        }
        case "product_entitlement_lifecycle": {
          await requireReleaseDecision(
            tx,
            input.userId,
            dependencies.applicationRevision,
            runtimeRevision,
          );
          await reconcileFounderCommerceEvent(tx, input, dependencies);
          break;
        }
        case "recovery_archive_lifecycle": {
          if (!lifecycleArchiveId) throw new Error("A verified Recovery Archive is required.");
          break;
        }
        case "infrastructure_retirement":
          throw new Error("Infrastructure Retirement must use its durable execution path.");
      }

      return {
        action: input.action,
        status: "passed",
        observedAt: input.now.toISOString(),
        providerCalls: dependencies.providers.calls(),
        cleanup,
      };
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

type Transaction = Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0];

async function requireReleaseDecision(
  tx: Transaction,
  userId: string,
  applicationRevision: string,
  runtimeRevision: string,
): Promise<void> {
  const [decision] = await tx
    .select({ id: founderReleaseDecisions.id })
    .from(founderReleaseDecisions)
    .where(
      and(
        eq(founderReleaseDecisions.userId, userId),
        eq(founderReleaseDecisions.stage, "owner_preview"),
        inArray(founderReleaseDecisions.outcome, ["enter", "resume"]),
        eq(founderReleaseDecisions.applicationRevision, applicationRevision),
        eq(founderReleaseDecisions.runtimeRevision, runtimeRevision),
      ),
    )
    .orderBy(desc(founderReleaseDecisions.decidedAt))
    .limit(1);
  if (!decision) throw new Error("An exact-revision Release Decision is required.");
}

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
};

async function executeInfrastructureRetirement(
  input: LifecycleInput,
  dependencies: LifecycleDependencies,
  connection: DatabaseConnection,
): Promise<FounderLifecycleOutcome> {
  const prepared = await prepareInfrastructureRetirement(input, dependencies, connection);
  if ("cleanup" in prepared) {
    return lifecycleOutcome(input, dependencies.providers, prepared.cleanup);
  }

  const archiveFulfillment = prepared.archiveNeedsExecution
    ? fulfillRecoveryArchiveIntent(
        input,
        dependencies.providers,
        connection,
        prepared.recoveryArchiveId,
        prepared.operatorId,
        false,
        () => input.now,
        prepared.runtimeRevision,
      )
    : Promise.resolve();

  try {
    const firewall = await dependencies.providers.digitalOcean.deleteFirewall(prepared.expectation);
    if (!firewall.ok) throw new Error(firewall.message);
    const droplet = await dependencies.providers.digitalOcean.deleteDroplet(prepared.expectation);
    if (!droplet.ok) throw new Error(droplet.message);
    const after = await dependencies.providers.digitalOcean.observeOwnedSet(prepared.expectation);
    if (!after.ok || after.value.state !== "absent") {
      throw new Error(after.ok ? "DigitalOcean resource absence was not verified." : after.message);
    }
    await archiveFulfillment;
    await completeInfrastructureRetirement(input, prepared, connection);
  } catch (error) {
    await retainInfrastructureRetirementFailure(input, prepared, error, connection);
    throw error;
  }

  return lifecycleOutcome(input, dependencies.providers, {
    resourcesBefore: prepared.resourcesBefore,
    resourcesAfter: 0,
    verified: true,
    observedAt: input.now.toISOString(),
  });
}

async function prepareInfrastructureRetirement(
  input: LifecycleInput,
  dependencies: LifecycleDependencies,
  connection: DatabaseConnection,
): Promise<RetirementWork | { cleanup: FounderLifecycleCleanup }> {
  return connection.db.transaction(async (tx) => {
    const { operatorId } = await requireActiveFounderOperatorAuthorityInTransaction(
      tx,
      input.userId,
    );
    const [runtime] = await tx
      .select({ configRevision: operatorRuntimes.configRevision })
      .from(operatorRuntimes)
      .where(eq(operatorRuntimes.operatorId, operatorId))
      .orderBy(desc(operatorRuntimes.updatedAt))
      .limit(1);
    if (!runtime?.configRevision) {
      throw new Error("Infrastructure Retirement requires a persisted runtime revision.");
    }
    await requireRetirementDue(tx, input.userId, input.now);

    const runnerCandidates = await tx
      .select()
      .from(runners)
      .where(
        and(
          eq(runners.userId, input.userId),
          eq(runners.kind, "digitalocean"),
          eq(runners.provider, "digitalocean"),
          inArray(runners.status, ["active", "online", "offline", "degraded"]),
          isNull(runners.deletedAt),
        ),
      )
      .limit(2)
      .for("update");
    if (runnerCandidates.length > 1) {
      throw new Error("Infrastructure Retirement runner identity is ambiguous.");
    }
    const [runner] = runnerCandidates;
    if (!runner) {
      const [completed] = await tx
        .select({
          resourcesBefore: founderInfrastructureRetirements.resourcesBefore,
          absenceVerifiedAt: founderInfrastructureRetirements.absenceVerifiedAt,
        })
        .from(founderInfrastructureRetirements)
        .where(
          and(
            eq(founderInfrastructureRetirements.userId, input.userId),
            eq(founderInfrastructureRetirements.status, "completed"),
          ),
        )
        .orderBy(desc(founderInfrastructureRetirements.updatedAt))
        .limit(1);
      if (completed?.absenceVerifiedAt) {
        return {
          cleanup: {
            resourcesBefore: completed.resourcesBefore,
            resourcesAfter: 0,
            verified: true,
            observedAt: completed.absenceVerifiedAt.toISOString(),
          },
        };
      }
      throw new Error("An exactly identified DigitalOcean runner is required.");
    }
    const [existing] = await tx
      .select()
      .from(founderInfrastructureRetirements)
      .where(eq(founderInfrastructureRetirements.runnerId, runner.id))
      .limit(1)
      .for("update");
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
    if (
      !runner?.providerResourceId ||
      !runner.providerFirewallId ||
      !runner.region ||
      !runner.sizeSlug ||
      !runner.provisioningOperationKey
    ) {
      throw new Error("An exactly identified DigitalOcean runner is required.");
    }
    const expectation = ownedSetExpectation({
      providerResourceId: runner.providerResourceId,
      providerFirewallId: runner.providerFirewallId,
      provisioningOperationKey: runner.provisioningOperationKey,
      name: runner.name,
      region: runner.region,
      sizeSlug: runner.sizeSlug,
    });
    const before = await dependencies.providers.digitalOcean.observeOwnedSet(expectation);
    if (!before.ok || (before.value.state !== "owned" && !existing)) {
      throw new Error(
        before.ok ? "DigitalOcean resources are not authoritatively owned." : before.message,
      );
    }
    const resourcesBefore = existing
      ? existing.resourcesBefore
      : Number(before.value.droplet === "present") + Number(before.value.firewall === "present");
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(input.now.valueOf() + 5 * 60 * 1_000);
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
          runtimeRevision: founderRecoveryArchives.runtimeRevision,
        })
        .from(founderRecoveryArchives)
        .where(eq(founderRecoveryArchives.id, recoveryArchiveId))
        .limit(1);
      if (!archive) throw new Error("Infrastructure Retirement Recovery Archive is missing.");
      if (archive.status === "pending" && !archive.runtimeRevision) {
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
        providerResourceId: runner.providerResourceId,
        providerFirewallId: runner.providerFirewallId,
        status: "in_progress",
        resourcesBefore,
        resourcesAfter: null,
        workStoppedAt: input.now,
        credentialsDisabledAt: input.now,
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
          externalActionPauseReason: "Infrastructure retirement in progress.",
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
      .select({ id: founderInfrastructureRetirements.id })
      .from(founderInfrastructureRetirements)
      .where(eq(founderInfrastructureRetirements.runnerId, runner.id))
      .limit(1);
    if (!receipt) throw new Error("Infrastructure Retirement receipt was not persisted.");
    if (!recoveryArchiveId) throw new Error("Recovery Archive intent was not persisted.");
    return {
      receiptId: receipt.id,
      leaseToken,
      runnerId: runner.id,
      operatorId,
      runtimeRevision: archiveRuntimeRevision,
      recoveryArchiveId,
      archiveNeedsExecution,
      expectation,
      resourcesBefore,
    };
  });
}

async function completeInfrastructureRetirement(
  input: LifecycleInput,
  work: RetirementWork,
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
        firewallDeletedAt: input.now,
        dropletDeletedAt: input.now,
        absenceVerifiedAt: input.now,
        failureCode: null,
        leaseExpiresAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(founderInfrastructureRetirements.id, work.receiptId));
  });
}

async function retainInfrastructureRetirementFailure(
  input: LifecycleInput,
  work: RetirementWork,
  error: unknown,
  connection: DatabaseConnection,
): Promise<void> {
  await connection.db
    .update(founderInfrastructureRetirements)
    .set({
      failureCode: error instanceof Error ? "provider_effect_failed" : "unknown_failure",
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

function ownedSetExpectation(runner: {
  providerResourceId: string;
  providerFirewallId: string;
  provisioningOperationKey: string;
  name: string;
  region: string;
  sizeSlug: string;
}): DigitalOceanOwnedSetExpectation {
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

function lifecycleOutcome(
  input: LifecycleInput,
  providers: FounderLifecycleProviderBoundary,
  cleanup: FounderLifecycleCleanup,
): FounderLifecycleOutcome {
  return {
    action: input.action,
    status: "passed",
    observedAt: input.now.toISOString(),
    providerCalls: providers.calls(),
    cleanup,
  };
}

function emptyCleanup(now: Date): FounderLifecycleCleanup {
  return {
    resourcesBefore: 0,
    resourcesAfter: 0,
    verified: true,
    observedAt: now.toISOString(),
  };
}
