import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderCommerceEvents,
  founderCheckoutCorrelations,
  founderInfrastructureRetirements,
  founderProductEntitlements,
  founderRecoveryArchives,
  founderRecoveryArchiveDeletionReceipts,
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
import type { FounderRecoveryArchiveDeletionProvider } from "./recovery-archive-provider";

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
    restorableVerified: true;
  }>;
  deleteRecoveryArchive(input: {
    archiveId: string;
    storageObjectKey: string;
    idempotencyKey: string;
  }): Promise<{ absent: true }>;
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
        await reconcileCommerceEvent(tx, input, dependencies);
      });
      return await executeInfrastructureRetirement(input, dependencies, connection);
    }
    const lifecycleArchiveId =
      input.action === "release_stage_admission" || input.action === "recovery_archive_lifecycle"
        ? await createDurableArchive(input, dependencies, connection)
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
              digest(`clerk:${identity.subject}`),
              digest(JSON.stringify(capabilities)),
              digest(`recovery-archive:${lifecycleArchiveId}`),
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
          await reconcileCommerceEvent(tx, input, dependencies);
          break;
        }
        case "recovery_archive_lifecycle": {
          await requireVerifiedEntitlement(tx, input.userId);
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

async function reconcileCommerceEvent(
  tx: Transaction,
  input: LifecycleInput,
  dependencies: LifecycleDependencies,
): Promise<void> {
  if (!input.commerceEvent) throw new Error("A signed commerce event is required.");
  const event = input.commerceEvent;
  const canonicalPayload = canonicalCommercePayload(event);
  if (!verifyHmac(canonicalPayload, event.signature, dependencies.commerceWebhookSecret)) {
    throw new Error("The Lemon Squeezy event signature is invalid.");
  }
  const payloadDigest = digest(canonicalPayload);
  const [existingReceipt] = await tx
    .select()
    .from(founderCommerceEvents)
    .where(eq(founderCommerceEvents.providerEventId, event.eventId))
    .limit(1);
  const [currentEntitlement] = await tx
    .select({
      sourceEventId: founderProductEntitlements.sourceEventId,
      providerSubscriptionId: founderProductEntitlements.providerSubscriptionId,
    })
    .from(founderProductEntitlements)
    .where(eq(founderProductEntitlements.userId, input.userId))
    .limit(1)
    .for("update");
  const [currentSource] = currentEntitlement
    ? await tx
        .select({
          id: founderCommerceEvents.id,
          checkoutCorrelationId: founderCommerceEvents.checkoutCorrelationId,
          occurredAt: founderCommerceEvents.occurredAt,
        })
        .from(founderCommerceEvents)
        .where(eq(founderCommerceEvents.id, currentEntitlement.sourceEventId))
        .limit(1)
    : [];
  const eventOccurredAt = new Date(event.occurredAt);
  if (
    Number.isNaN(eventOccurredAt.valueOf()) ||
    eventOccurredAt.toISOString() !== event.occurredAt
  ) {
    throw new Error("The Lemon Squeezy event timestamp is invalid.");
  }
  if (
    currentSource &&
    ((existingReceipt && existingReceipt.id !== currentSource.id) ||
      (!existingReceipt && eventOccurredAt <= currentSource.occurredAt))
  ) {
    throw new Error("A delayed or reordered commerce event cannot replace newer authority.");
  }
  let receipt = existingReceipt;
  if (!receipt) {
    let correlationId: string;
    if (event.status === "active") {
      const [correlation] = await tx
        .select({ id: founderCheckoutCorrelations.id })
        .from(founderCheckoutCorrelations)
        .where(
          and(
            eq(founderCheckoutCorrelations.userId, input.userId),
            eq(founderCheckoutCorrelations.correlationDigest, digest(event.checkoutCorrelation)),
            eq(founderCheckoutCorrelations.status, "pending"),
            gt(founderCheckoutCorrelations.expiresAt, input.now),
          ),
        )
        .limit(1)
        .for("update");
      if (!correlation) {
        throw new Error("A pending Owner-bound Checkout Correlation is required.");
      }
      correlationId = correlation.id;
      await tx
        .update(founderCheckoutCorrelations)
        .set({ status: "consumed", consumedAt: input.now })
        .where(eq(founderCheckoutCorrelations.id, correlation.id));
    } else {
      if (
        !currentEntitlement ||
        currentEntitlement.providerSubscriptionId !== event.subscriptionId
      ) {
        throw new Error("The commerce event does not match the Owner's Product Entitlement.");
      }
      const [correlation] = currentSource
        ? await tx
            .select({ id: founderCheckoutCorrelations.id })
            .from(founderCheckoutCorrelations)
            .where(
              and(
                eq(founderCheckoutCorrelations.id, currentSource.checkoutCorrelationId),
                eq(founderCheckoutCorrelations.userId, input.userId),
                eq(
                  founderCheckoutCorrelations.correlationDigest,
                  digest(event.checkoutCorrelation),
                ),
              ),
            )
            .limit(1)
        : [];
      if (!correlation) throw new Error("The commerce event Checkout Correlation is invalid.");
      correlationId = correlation.id;
    }
    [receipt] = await tx
      .insert(founderCommerceEvents)
      .values({
        providerEventId: event.eventId,
        userId: input.userId,
        checkoutCorrelationId: correlationId,
        providerSubscriptionId: event.subscriptionId,
        eventType: `subscription_${event.status}`,
        payloadDigest,
        signatureVerified: true,
        occurredAt: eventOccurredAt,
        recordedAt: input.now,
      })
      .returning();
  }
  if (
    !receipt ||
    receipt.userId !== input.userId ||
    receipt.payloadDigest !== payloadDigest ||
    receipt.providerSubscriptionId !== event.subscriptionId
  ) {
    throw new Error("The Lemon Squeezy event ID was previously recorded differently.");
  }
  const subscription = await dependencies.providers.readSubscription({
    subscriptionId: event.subscriptionId,
  });
  if (subscription.status !== event.status) {
    throw new Error("The current Lemon Squeezy subscription state does not match the event.");
  }
  const status = subscription.status === "active" ? "verified" : subscription.status;
  const retirementDueAt = entitlementRetirementDueAt(event);
  await tx
    .insert(founderProductEntitlements)
    .values({
      userId: input.userId,
      sourceEventId: receipt.id,
      providerSubscriptionId: event.subscriptionId,
      status,
      reconciledProviderStatus: subscription.status,
      reconciledAt: input.now,
      retirementDueAt,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: founderProductEntitlements.userId,
      set: {
        sourceEventId: receipt.id,
        providerSubscriptionId: event.subscriptionId,
        status,
        reconciledProviderStatus: subscription.status,
        reconciledAt: input.now,
        retirementDueAt,
        updatedAt: input.now,
      },
    });
}

function entitlementRetirementDueAt(event: FounderCommerceEvent): Date | null {
  const occurredAt = new Date(event.occurredAt);
  switch (event.status) {
    case "active":
    case "past_due":
      return null;
    case "unpaid":
    case "refunded":
      return new Date(occurredAt.valueOf() + 24 * 60 * 60 * 1_000);
    case "expired":
      return new Date(occurredAt.valueOf() + 60 * 60 * 1_000);
    case "cancelled":
      if (!event.endsAt) throw new Error("Cancelled entitlement requires its paid ends_at.");
      return new Date(event.endsAt);
  }
}

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

async function requireVerifiedEntitlement(tx: Transaction, userId: string): Promise<void> {
  const [entitlement] = await tx
    .select({ id: founderProductEntitlements.id })
    .from(founderProductEntitlements)
    .where(
      and(
        eq(founderProductEntitlements.userId, userId),
        eq(founderProductEntitlements.status, "verified"),
      ),
    )
    .limit(1);
  if (!entitlement) throw new Error("Verified Product Entitlement is required.");
}

async function requireRetirementDue(tx: Transaction, userId: string, now: Date): Promise<void> {
  const [entitlement] = await tx
    .select({ id: founderProductEntitlements.id })
    .from(founderProductEntitlements)
    .where(
      and(
        eq(founderProductEntitlements.userId, userId),
        inArray(founderProductEntitlements.status, ["unpaid", "cancelled", "expired", "refunded"]),
        lte(founderProductEntitlements.retirementDueAt, now),
      ),
    )
    .limit(1);
  if (!entitlement) throw new Error("Product Entitlement retirement is not due.");
}

export async function expireFounderRecoveryArchivesForUser(
  userId: string,
  now: Date,
  providers: FounderRecoveryArchiveDeletionProvider,
  connection: DatabaseConnection,
): Promise<void> {
  while (true) {
    const work = await connection.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:founder-lifecycle:${userId}`}, 0))`,
      );
      const [archive] = await tx
        .select({
          id: founderRecoveryArchives.id,
          storageObjectKey: founderRecoveryArchives.storageObjectKey,
        })
        .from(founderRecoveryArchives)
        .where(
          and(
            eq(founderRecoveryArchives.userId, userId),
            eq(founderRecoveryArchives.status, "verified"),
            lte(founderRecoveryArchives.expiresAt, now),
            isNull(founderRecoveryArchives.deletedAt),
          ),
        )
        .orderBy(founderRecoveryArchives.expiresAt)
        .limit(1)
        .for("update");
      if (!archive?.storageObjectKey) return null;
      const idempotencyKey = digest(`recovery-archive-delete:${archive.id}`);
      const [existingDeletion] = await tx
        .select({
          status: founderRecoveryArchiveDeletionReceipts.status,
          attemptedAt: founderRecoveryArchiveDeletionReceipts.attemptedAt,
          failureCode: founderRecoveryArchiveDeletionReceipts.failureCode,
        })
        .from(founderRecoveryArchiveDeletionReceipts)
        .where(eq(founderRecoveryArchiveDeletionReceipts.archiveId, archive.id))
        .limit(1)
        .for("update");
      if (
        existingDeletion?.status === "pending" &&
        existingDeletion.failureCode === null &&
        existingDeletion.attemptedAt > new Date(now.valueOf() - 5 * 60 * 1_000)
      ) {
        throw new Error("Recovery Archive deletion is already in progress.");
      }
      await tx
        .insert(founderRecoveryArchiveDeletionReceipts)
        .values({
          archiveId: archive.id,
          userId,
          idempotencyKey,
          status: "pending",
          providerConfirmed: false,
          attemptedAt: now,
          completedAt: null,
          failureCode: null,
        })
        .onConflictDoUpdate({
          target: founderRecoveryArchiveDeletionReceipts.archiveId,
          set: { attemptedAt: now, failureCode: null },
        });
      return { archiveId: archive.id, storageObjectKey: archive.storageObjectKey, idempotencyKey };
    });
    if (!work) return;
    try {
      const deleted = await providers.deleteRecoveryArchive(work);
      if (!deleted.absent) throw new Error("Recovery Archive absence was not confirmed.");
      await connection.db.transaction(async (tx) => {
        await tx
          .update(founderRecoveryArchives)
          .set({
            status: "deleted",
            storageObjectKey: null,
            restorableVerified: false,
            failureCode: null,
            deletedAt: now,
          })
          .where(eq(founderRecoveryArchives.id, work.archiveId));
        await tx
          .update(founderRecoveryArchiveDeletionReceipts)
          .set({
            status: "completed",
            providerConfirmed: true,
            completedAt: now,
            failureCode: null,
          })
          .where(eq(founderRecoveryArchiveDeletionReceipts.archiveId, work.archiveId));
      });
    } catch (error) {
      await connection.db
        .update(founderRecoveryArchiveDeletionReceipts)
        .set({ failureCode: "archive_delete_failed", attemptedAt: now })
        .where(eq(founderRecoveryArchiveDeletionReceipts.archiveId, work.archiveId));
      throw error;
    }
  }
}

async function createDurableArchive(
  input: LifecycleInput,
  dependencies: LifecycleDependencies,
  connection: DatabaseConnection,
): Promise<string> {
  const intent = await connection.db.transaction(async (tx) => {
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
    if (input.action === "recovery_archive_lifecycle") {
      await requireVerifiedEntitlement(tx, input.userId);
    }
    const [record] = await tx
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
    if (!record) throw new Error("Recovery Archive intent was not persisted.");
    return { archiveId: record.id, operatorId: operator.id };
  });

  await fulfillArchiveIntent(
    input,
    dependencies.providers,
    connection,
    intent.archiveId,
    intent.operatorId,
    true,
  );
  return intent.archiveId;
}

async function fulfillArchiveIntent(
  input: LifecycleInput,
  providers: FounderLifecycleProviderBoundary,
  connection: DatabaseConnection,
  archiveId: string,
  operatorId: string,
  failClosed: boolean,
): Promise<void> {
  try {
    const archive = await providers.createRecoveryArchive({
      archiveIntentId: archiveId,
      userId: input.userId,
      operatorId,
      observedAt: input.now,
    });
    await connection.db
      .update(founderRecoveryArchives)
      .set({
        status: "verified",
        storageObjectKey: archive.storageObjectKey,
        ciphertextDigest: archive.ciphertextDigest,
        restorableVerified: archive.restorableVerified,
        failureCode: null,
      })
      .where(eq(founderRecoveryArchives.id, archiveId));
  } catch (error) {
    await connection.db
      .update(founderRecoveryArchives)
      .set({ status: "failed", restorableVerified: false, failureCode: "archive_create_failed" })
      .where(eq(founderRecoveryArchives.id, archiveId));
    if (failClosed) throw error;
  }
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
    await fulfillArchiveIntent(
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
        idempotencyKey: digest(`${input.userId}:${runner.id}`),
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

function canonicalCommercePayload(event: FounderCommerceEvent): string {
  return JSON.stringify({
    eventId: event.eventId,
    checkoutCorrelation: event.checkoutCorrelation,
    subscriptionId: event.subscriptionId,
    status: event.status,
    endsAt: event.endsAt,
    occurredAt: event.occurredAt,
  });
}

function verifyHmac(payload: string, signature: string, secret: string): boolean {
  if (!secret) return false;
  const expected = `hmac-sha256:${createHmac("sha256", secret).update(payload).digest("hex")}`;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function emptyCleanup(now: Date): FounderLifecycleCleanup {
  return {
    resourcesBefore: 0,
    resourcesAfter: 0,
    verified: true,
    observedAt: now.toISOString(),
  };
}
