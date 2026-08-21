import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderInfrastructureRetirements,
  founderRecoveryArchives,
  founderReleaseDecisions,
  operatorPreparations,
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
import { createDurableRecoveryArchive, fulfillRecoveryArchiveIntent } from "./recovery-archive";
import type {
  FounderRecoveryArchiveDeletionIdentity,
  FounderRecoveryArchiveDeletionOutcome,
} from "./recovery-archive-provider";

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

export type FounderLifecycleProviderBoundary = {
  authenticateIdentity(input: { userId: string }): Promise<{ subject: string }>;
  verifyCapabilityProviders(): Promise<{
    openAI: true;
    anthropic: true;
    google: true;
  }>;
  readSubscription(input: { subscriptionId: string }): Promise<{ status: FounderCommerceStatus }>;
  createRecoveryArchive(input: {
    archiveIntentId: string;
    userId: string;
    operatorId: string;
    observedAt: Date;
  }): Promise<{
    storageObjectKey: string;
    ciphertextDigest: `sha256:${string}`;
    recoveryCredentialDigest: `sha256:${string}`;
    restorableVerified: true;
  }>;
  deleteRecoveryArchive(
    input: FounderRecoveryArchiveDeletionIdentity,
  ): Promise<FounderRecoveryArchiveDeletionOutcome>;
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
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:founder-lifecycle:${input.userId}`}, 0))`,
        );
        await reconcileFounderCommerceEvent(tx, input, dependencies);
      });
      return await executeInfrastructureRetirement(input, dependencies, connection);
    }
    const lifecycleArchiveId =
      input.action === "release_stage_admission" || input.action === "recovery_archive_lifecycle"
        ? await createDurableRecoveryArchive(input, dependencies.providers, connection)
        : null;
    return await connection.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:founder-lifecycle:${input.userId}`}, 0))`,
      );

      const [operator] = await tx
        .select({ id: operators.id })
        .from(operators)
        .where(and(eq(operators.userId, input.userId), eq(operators.status, "active")))
        .limit(1)
        .for("update");
      if (!operator) throw new Error("An active persisted Operator is required.");

      const [preparation] = await tx
        .select({ status: operatorPreparations.status })
        .from(operatorPreparations)
        .where(eq(operatorPreparations.operatorId, operator.id))
        .limit(1);
      if (preparation?.status !== "ready") {
        throw new Error("A ready persisted Operator preparation is required.");
      }
      const runtimeRevision = await requireReadyRuntimeRevision(tx, operator.id);

      const cleanup = emptyCleanup(input.now);
      switch (input.action) {
        case "release_stage_admission": {
          const identity = await dependencies.providers.authenticateIdentity({
            userId: input.userId,
          });
          if (!identity.subject) throw new Error("Clerk identity authentication was inconclusive.");
          const capabilities = await dependencies.providers.verifyCapabilityProviders();
          if (!lifecycleArchiveId) throw new Error("A verified Recovery Archive is required.");
          await tx.insert(founderReleaseDecisions).values({
            userId: input.userId,
            operatorId: operator.id,
            stage: "owner_preview",
            outcome: "enter",
            applicationRevision: dependencies.applicationRevision,
            runtimeRevision,
            capabilityManifest: ["openai", "calendar_reading"],
            evidenceDigests: [
              founderProductContractDigest(`clerk:${identity.subject}`),
              founderProductContractDigest(JSON.stringify(capabilities)),
              founderProductContractDigest(`recovery-archive:${lifecycleArchiveId}`),
            ],
            decidedAt: input.now,
            createdAt: input.now,
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
        eq(founderReleaseDecisions.outcome, "enter"),
        eq(founderReleaseDecisions.applicationRevision, applicationRevision),
        eq(founderReleaseDecisions.runtimeRevision, runtimeRevision),
      ),
    )
    .orderBy(desc(founderReleaseDecisions.decidedAt))
    .limit(1);
  if (!decision) throw new Error("An exact-revision Release Decision is required.");
}

async function requireReadyRuntimeRevision(tx: Transaction, operatorId: string): Promise<string> {
  const [runtime] = await tx
    .select({ configRevision: operatorRuntimes.configRevision })
    .from(operatorRuntimes)
    .where(and(eq(operatorRuntimes.operatorId, operatorId), eq(operatorRuntimes.status, "ready")))
    .orderBy(desc(operatorRuntimes.updatedAt))
    .limit(1);
  if (!runtime?.configRevision) throw new Error("A ready persisted runtime revision is required.");
  return runtime.configRevision;
}

type RetirementWork = {
  receiptId: string;
  leaseToken: string;
  runnerId: string;
  operatorId: string;
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

  if (prepared.archiveNeedsExecution) {
    await fulfillRecoveryArchiveIntent(
      input,
      dependencies.providers,
      connection,
      prepared.recoveryArchiveId,
      prepared.operatorId,
      false,
    );
  }

  try {
    const firewall = await dependencies.providers.digitalOcean.deleteFirewall(prepared.expectation);
    if (!firewall.ok) throw new Error(firewall.message);
    const droplet = await dependencies.providers.digitalOcean.deleteDroplet(prepared.expectation);
    if (!droplet.ok) throw new Error(droplet.message);
    const after = await dependencies.providers.digitalOcean.observeOwnedSet(prepared.expectation);
    if (!after.ok || after.value.state !== "absent") {
      throw new Error(after.ok ? "DigitalOcean resource absence was not verified." : after.message);
    }
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
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:founder-lifecycle:${input.userId}`}, 0))`,
    );
    const [operator] = await tx
      .select({ id: operators.id })
      .from(operators)
      .where(and(eq(operators.userId, input.userId), eq(operators.status, "active")))
      .limit(1)
      .for("update");
    if (!operator) throw new Error("An active persisted Operator is required.");
    const [preparation] = await tx
      .select({ status: operatorPreparations.status })
      .from(operatorPreparations)
      .where(eq(operatorPreparations.operatorId, operator.id))
      .limit(1);
    if (preparation?.status !== "ready") {
      throw new Error("A ready persisted Operator preparation is required.");
    }
    const runtimeRevision = await requireReadyRuntimeRevision(tx, operator.id);
    await requireReleaseDecision(
      tx,
      input.userId,
      dependencies.applicationRevision,
      runtimeRevision,
    );
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

    if (existing) {
      if (!recoveryArchiveId) {
        throw new Error("Infrastructure Retirement is missing its Recovery Archive intent.");
      }
      const [archive] = await tx
        .select({ status: founderRecoveryArchives.status })
        .from(founderRecoveryArchives)
        .where(eq(founderRecoveryArchives.id, recoveryArchiveId))
        .limit(1);
      if (!archive) throw new Error("Infrastructure Retirement Recovery Archive is missing.");
      archiveNeedsExecution = archive.status === "pending";
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
      const [archiveIntent] = await tx
        .insert(founderRecoveryArchives)
        .values({
          userId: input.userId,
          operatorId: operator.id,
          status: "pending",
          storageObjectKey: null,
          ciphertextDigest: null,
          restorableVerified: false,
          failureCode: null,
          observedAt: input.now,
          expiresAt: new Date(input.now.valueOf() + 30 * 24 * 60 * 60 * 1_000),
          createdAt: input.now,
        })
        .returning({ id: founderRecoveryArchives.id });
      if (!archiveIntent) throw new Error("Recovery Archive intent was not persisted.");
      recoveryArchiveId = archiveIntent.id;
      archiveNeedsExecution = true;
      await tx.insert(founderInfrastructureRetirements).values({
        userId: input.userId,
        runnerId: runner.id,
        recoveryArchiveId: archiveIntent.id,
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
        .where(eq(operators.id, operator.id));
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
      operatorId: operator.id,
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
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:founder-lifecycle:${input.userId}`}, 0))`,
    );
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
