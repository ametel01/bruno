import "server-only";

import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderCheckoutCorrelations,
  founderCommerceEvents,
  founderInfrastructureRetirements,
  founderOperatorRestorations,
  founderProductEntitlements,
  founderRecoveryArchiveDeletionReceipts,
  founderRecoveryArchives,
  operatorPreparations,
  operatorRuntimes,
  operators,
  runners,
} from "@/src/server/db/schema";
import type { FounderRecoveryArchiveDurableState } from "./recovery-archive-provider";
import { founderProductContractDigest } from "./digest";
import { lockFounderProductContractLifecycleInTransaction } from "./operator-authority";

const RESTORATION_PAUSE_REASON = "Returning Founder restoration is still being verified.";

export type FounderRestorationInfrastructureIdentity = {
  runnerId: string;
  persistedRunner: boolean;
  providerResourceId: string;
  providerFirewallId: string;
  endpointUrl: string;
  runtimeIdentity: string;
  operationTag: string;
  name: string;
  region: string;
  sizeSlug: string;
  image: string;
  createdAt: Date;
};

export type FounderReturningRestorationProvider = {
  verifyRecoveryArchive(input: {
    archiveId: string;
    userId: string;
    operatorId: string;
    storageObjectKey: string;
    recoveryCredentialObjectKey: string;
    ciphertextDigest: `sha256:${string}`;
    recoveryCredentialDigest: `sha256:${string}`;
    stateDigest: `sha256:${string}`;
  }): Promise<FounderRecoveryArchiveDurableState>;
  provisionNewInfrastructure(input: {
    userId: string;
    operatorId: string;
    runnerId: string;
    idempotencyKey: string;
  }): Promise<
    | { state: "ready"; value: FounderRestorationInfrastructureIdentity }
    | { state: "pending"; value: FounderRestorationInfrastructureIdentity | null }
    | {
        state: "failed";
        code: string;
        partial: FounderRestorationInfrastructureIdentity | null;
      }
  >;
  observeNewInfrastructure(input: {
    userId: string;
    operatorId: string;
    runnerId: string;
    idempotencyKey: string;
  }): ReturnType<FounderReturningRestorationProvider["provisionNewInfrastructure"]>;
  reauthorizeAiProviders(input: {
    userId: string;
    operatorId: string;
    requiredAfter: Date;
  }): Promise<{
    openAI: boolean;
    anthropic: boolean;
  }>;
  reauthorizeCompanyProviders(input: {
    userId: string;
    operatorId: string;
    requiredAfter: Date;
  }): Promise<{
    calendar: boolean;
    mail: boolean;
  }>;
  retireRestorationInfrastructure(
    input: FounderRestorationInfrastructureIdentity,
  ): Promise<{ dropletAbsent: true; firewallAbsent: true }>;
  refundRestorationPayment(input: {
    subscriptionId: string;
    orderId: string;
  }): Promise<{ fullRefundConfirmed: true }>;
  calls(): readonly string[];
};

export type FounderReturningRestorationOutcome = {
  mode: "same_logical_operator" | "new_operator_environment";
  status: "completed" | "provider_reauthorization_required" | "restoring" | "refunded";
  logicalOperatorPreserved: boolean;
  newInfrastructureIdentity: boolean;
  providerReauthorizationRequired: true;
  providerReauthorizationCompleted: boolean;
  workResumed: boolean;
  fullRefundConfirmed: boolean;
  cleanupVerified: boolean;
  archiveDeletionAuthoritative: boolean;
  providerCalls: readonly string[];
};

export type FounderReturningRestorationStatusDto =
  | { state: "unavailable" }
  | {
      state:
        | "restoring"
        | "provider_reauthorization_required"
        | "ready"
        | "refunded"
        | "needs_attention";
      environment: "same Operator, new infrastructure" | "new Operator environment";
      providerAccess: "reauthorization required" | "ready" | "not carried forward";
      payment: "verified" | "refunded";
      work: "paused" | "resumed";
    };

type PreparedRestoration = {
  restorationId: string;
  leaseToken: string;
  userId: string;
  sourceEventId: string;
  sourceOperatorId: string;
  restoredOperatorId: string;
  sourceRetirementId: string;
  oldProviderResourceId: string;
  oldProviderFirewallId: string;
  oldRuntimeIdentity: string;
  oldEndpointUrl: string | null;
  providerSubscriptionId: string;
  providerOrderId: string;
  checkoutCorrelationId: string;
  archive: {
    id: string;
    storageObjectKey: string;
    recoveryCredentialObjectKey: string;
    ciphertextDigest: `sha256:${string}`;
    recoveryCredentialDigest: `sha256:${string}`;
    stateDigest: `sha256:${string}`;
  } | null;
  runnerId: string;
  infrastructure: FounderRestorationInfrastructureIdentity | null;
  providerReauthorizationRequiredAfter: Date;
};

export async function executeFounderReturningRestoration(
  input: { userId: string; sourceEventId: string; now: Date },
  dependencies: {
    provider: FounderReturningRestorationProvider;
    createConnection?: () => DatabaseConnection;
  },
): Promise<FounderReturningRestorationOutcome> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  let prepared: PreparedRestoration | null = null;
  let infrastructure: FounderRestorationInfrastructureIdentity | null = null;
  let compensationStarted = false;
  try {
    prepared = await prepareRestoration(input, connection);
    if (!prepared.archive) {
      compensationStarted = true;
      await refundAndClose(
        prepared,
        null,
        "recovery_archive_unavailable",
        input.now,
        dependencies,
        connection,
      );
      return restorationOutcome("new_operator_environment", dependencies.provider, {
        fullRefundConfirmed: true,
        cleanupVerified: true,
      });
    }

    const restoredState = await dependencies.provider.verifyRecoveryArchive({
      archiveId: prepared.archive.id,
      userId: prepared.userId,
      operatorId: prepared.sourceOperatorId,
      storageObjectKey: prepared.archive.storageObjectKey,
      recoveryCredentialObjectKey: prepared.archive.recoveryCredentialObjectKey,
      ciphertextDigest: prepared.archive.ciphertextDigest,
      recoveryCredentialDigest: prepared.archive.recoveryCredentialDigest,
      stateDigest: prepared.archive.stateDigest,
    });
    if (
      restoredState.operator.id !== prepared.sourceOperatorId ||
      restoredState.restoration.logicalOperatorId !== prepared.sourceOperatorId ||
      !restoredState.restoration.providerReauthorizationRequired ||
      restoredState.restoration.reusableCredentials.length !== 0
    ) {
      throw new Error("Recovery Archive did not preserve the exact logical Operator boundary.");
    }

    const provisioningInput = {
      userId: prepared.userId,
      operatorId: prepared.restoredOperatorId,
      runnerId: prepared.runnerId,
      idempotencyKey: founderProductContractDigest(`returning-founder:${prepared.restorationId}`),
    };
    const provisioned = prepared.infrastructure
      ? await dependencies.provider.observeNewInfrastructure(provisioningInput)
      : await dependencies.provider.provisionNewInfrastructure(provisioningInput);
    infrastructure = provisioned.state === "failed" ? provisioned.partial : provisioned.value;
    if (provisioned.state === "failed") {
      compensationStarted = true;
      await refundAndClose(
        prepared,
        infrastructure,
        provisioned.code,
        input.now,
        dependencies,
        connection,
      );
      return restorationOutcome("same_logical_operator", dependencies.provider, {
        fullRefundConfirmed: true,
        cleanupVerified: true,
      });
    }
    if (provisioned.state === "pending" && !provisioned.value) {
      return restorationOutcome("same_logical_operator", dependencies.provider, {
        status: "restoring",
        fullRefundConfirmed: false,
        cleanupVerified: false,
      });
    }
    const provisionedInfrastructure = provisioned.value;
    if (!provisionedInfrastructure) {
      throw new Error("Restoration Infrastructure identity was unavailable.");
    }
    infrastructure = provisionedInfrastructure;
    assertNewInfrastructureIdentity(prepared, provisionedInfrastructure);
    prepared.runnerId = provisionedInfrastructure.runnerId;
    if (provisioned.state === "pending") {
      await persistPendingInfrastructure(
        prepared,
        provisionedInfrastructure,
        input.now,
        connection,
      );
      return restorationOutcome("same_logical_operator", dependencies.provider, {
        status: "restoring",
        fullRefundConfirmed: false,
        cleanupVerified: false,
      });
    }
    await persistProvisionedInfrastructure(
      prepared,
      provisionedInfrastructure,
      restoredState,
      input.now,
      connection,
    );

    const [ai, company] = await Promise.all([
      dependencies.provider.reauthorizeAiProviders({
        userId: prepared.userId,
        operatorId: prepared.restoredOperatorId,
        requiredAfter: prepared.providerReauthorizationRequiredAfter,
      }),
      dependencies.provider.reauthorizeCompanyProviders({
        userId: prepared.userId,
        operatorId: prepared.restoredOperatorId,
        requiredAfter: prepared.providerReauthorizationRequiredAfter,
      }),
    ]);
    if (!ai.openAI || !ai.anthropic || !company.calendar || !company.mail) {
      return restorationOutcome("same_logical_operator", dependencies.provider, {
        status: "provider_reauthorization_required",
        fullRefundConfirmed: false,
        cleanupVerified: false,
      });
    }
    await completeRestoration(prepared, provisionedInfrastructure, input.now, connection);
    return {
      mode: "same_logical_operator",
      status: "completed",
      logicalOperatorPreserved: true,
      newInfrastructureIdentity: true,
      providerReauthorizationRequired: true,
      providerReauthorizationCompleted: true,
      workResumed: true,
      fullRefundConfirmed: false,
      cleanupVerified: true,
      archiveDeletionAuthoritative: true,
      providerCalls: dependencies.provider.calls(),
    };
  } catch (error) {
    if (prepared) {
      // A cleanup or refund failure must be retried by the next reconciliation
      // lease. Re-entering compensation in this invocation could issue the same
      // provider mutation twice before its first result is observable.
      if (compensationStarted) throw error;
      const failureCode = restorationFailureCode(error);
      await refundAndClose(
        prepared,
        infrastructure,
        failureCode,
        input.now,
        dependencies,
        connection,
      );
      return restorationOutcome(
        prepared.archive ? "same_logical_operator" : "new_operator_environment",
        dependencies.provider,
        { fullRefundConfirmed: true, cleanupVerified: true },
      );
    }
    throw error;
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function getFounderReturningRestorationStatusForUser(
  userId: string,
  dependencies: { createConnection?: () => DatabaseConnection } = {},
): Promise<FounderReturningRestorationStatusDto> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const [restoration] = await connection.db
      .select()
      .from(founderOperatorRestorations)
      .where(eq(founderOperatorRestorations.userId, userId))
      .orderBy(desc(founderOperatorRestorations.createdAt))
      .limit(1);
    if (!restoration) return { state: "unavailable" };
    const environment =
      restoration.mode === "same_logical_operator"
        ? ("same Operator, new infrastructure" as const)
        : ("new Operator environment" as const);
    if (restoration.status === "completed") {
      return {
        state: "ready",
        environment,
        providerAccess: "ready",
        payment: "verified",
        work: "resumed",
      };
    }
    if (restoration.status === "refunded") {
      return {
        state: "refunded",
        environment,
        providerAccess: "not carried forward",
        payment: "refunded",
        work: "paused",
      };
    }
    return {
      state:
        restoration.status === "provider_reauthorization_required"
          ? "provider_reauthorization_required"
          : restoration.status === "failed"
            ? "needs_attention"
            : "restoring",
      environment,
      providerAccess: "reauthorization required",
      payment: "verified",
      work: "paused",
    };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

async function prepareRestoration(
  input: { userId: string; sourceEventId: string; now: Date },
  connection: DatabaseConnection,
): Promise<PreparedRestoration> {
  return connection.db.transaction(async (tx) => {
    await lockFounderProductContractLifecycleInTransaction(tx, input.userId);
    const [event] = await tx
      .select({
        id: founderCommerceEvents.id,
        userId: founderCommerceEvents.userId,
        subscriptionId: founderCommerceEvents.providerSubscriptionId,
        orderId: founderCommerceEvents.providerOrderId,
        signatureVerified: founderCommerceEvents.signatureVerified,
        applicationStatus: founderCommerceEvents.applicationStatus,
        checkoutCorrelationId: founderCommerceEvents.checkoutCorrelationId,
      })
      .from(founderCommerceEvents)
      .where(eq(founderCommerceEvents.id, input.sourceEventId))
      .limit(1)
      .for("update");
    if (
      !event ||
      event.userId !== input.userId ||
      !event.signatureVerified ||
      event.applicationStatus !== "pending"
    ) {
      throw new Error("Fresh verified restoration payment evidence is required.");
    }
    const [correlation] = await tx
      .select()
      .from(founderCheckoutCorrelations)
      .where(eq(founderCheckoutCorrelations.id, event.checkoutCorrelationId))
      .limit(1)
      .for("update");
    if (
      !correlation ||
      correlation.userId !== input.userId ||
      correlation.status !== "consumed" ||
      correlation.providerSubscriptionId !== event.subscriptionId ||
      correlation.providerOrderId !== event.orderId
    ) {
      throw new Error("Fresh Checkout Correlation authority is required for restoration.");
    }
    const [retirement] = await tx
      .select()
      .from(founderInfrastructureRetirements)
      .where(
        and(
          eq(founderInfrastructureRetirements.userId, input.userId),
          eq(founderInfrastructureRetirements.status, "completed"),
        ),
      )
      .orderBy(desc(founderInfrastructureRetirements.absenceVerifiedAt))
      .limit(1)
      .for("update");
    if (
      !retirement?.absenceVerifiedAt ||
      retirement.providerDropletState !== "absent" ||
      retirement.providerFirewallState !== "absent"
    ) {
      throw new Error("Authoritative prior Infrastructure Retirement is required.");
    }
    const [sourceRunner] = await tx
      .select({ endpointUrl: runners.endpointUrl })
      .from(runners)
      .where(eq(runners.id, retirement.runnerId))
      .limit(1);
    const [sourceOperator] = await tx
      .select()
      .from(operators)
      .where(and(eq(operators.userId, input.userId), eq(operators.status, "active")))
      .limit(1)
      .for("update");
    if (!sourceOperator) throw new Error("Returning Founder Operator authority is unavailable.");

    const [existing] = await tx
      .select()
      .from(founderOperatorRestorations)
      .where(eq(founderOperatorRestorations.sourceEventId, event.id))
      .limit(1)
      .for("update");
    if (
      existing &&
      (existing.status === "in_progress" || existing.status === "provider_reauthorization_required")
    ) {
      const leaseToken = randomUUID();
      const [claimed] = await tx
        .update(founderOperatorRestorations)
        .set({
          attemptCount: existing.attemptCount + 1,
          leaseToken,
          leaseExpiresAt: new Date(input.now.valueOf() + 5 * 60 * 1_000),
          updatedAt: input.now,
        })
        .where(
          and(
            eq(founderOperatorRestorations.id, existing.id),
            eq(founderOperatorRestorations.leaseToken, existing.leaseToken),
          ),
        )
        .returning({ id: founderOperatorRestorations.id });
      if (!claimed) throw new Error("Returning Founder restoration lease was not renewed.");
      const [existingArchive] = existing.recoveryArchiveId
        ? await tx
            .select()
            .from(founderRecoveryArchives)
            .where(eq(founderRecoveryArchives.id, existing.recoveryArchiveId))
            .limit(1)
        : [];
      const [existingRunner] = existing.newRunnerId
        ? await tx
            .select()
            .from(runners)
            .where(and(eq(runners.id, existing.newRunnerId), eq(runners.userId, input.userId)))
            .limit(1)
        : [];
      return {
        restorationId: existing.id,
        leaseToken,
        userId: input.userId,
        sourceEventId: event.id,
        sourceOperatorId: existing.sourceOperatorId,
        restoredOperatorId: existing.restoredOperatorId,
        sourceRetirementId: existing.sourceRetirementId,
        oldProviderResourceId: existing.oldProviderResourceId,
        oldProviderFirewallId: existing.oldProviderFirewallId,
        oldRuntimeIdentity: existing.oldRuntimeIdentity,
        oldEndpointUrl: sourceRunner?.endpointUrl ?? null,
        providerSubscriptionId: event.subscriptionId,
        providerOrderId: event.orderId,
        checkoutCorrelationId: event.checkoutCorrelationId,
        archive: existingArchive
          ? {
              id: existingArchive.id,
              storageObjectKey: requiredText(existingArchive.storageObjectKey, "archive object"),
              recoveryCredentialObjectKey: requiredText(
                existingArchive.recoveryCredentialObjectKey,
                "recovery credential",
              ),
              ciphertextDigest: requiredDigest(existingArchive.ciphertextDigest),
              recoveryCredentialDigest: requiredDigest(existingArchive.recoveryCredentialDigest),
              stateDigest: requiredDigest(existingArchive.stateDigest),
            }
          : null,
        runnerId: existing.newRunnerId ?? randomUUID(),
        infrastructure:
          existingRunner &&
          existing.newProviderResourceId &&
          existing.newProviderFirewallId &&
          existing.newRuntimeIdentity &&
          existingRunner.endpointUrl
            ? {
                runnerId: existingRunner.id,
                persistedRunner: true,
                providerResourceId: existing.newProviderResourceId,
                providerFirewallId: existing.newProviderFirewallId,
                endpointUrl: existingRunner.endpointUrl,
                runtimeIdentity: existing.newRuntimeIdentity,
                operationTag: requiredText(
                  existingRunner.provisioningOperationKey,
                  "provisioning operation",
                ),
                name: existingRunner.name,
                region: requiredText(existingRunner.region, "runner region"),
                sizeSlug: requiredText(existingRunner.sizeSlug, "runner size"),
                image: requiredText(existingRunner.image, "runner image"),
                createdAt: existingRunner.createdAt,
              }
            : null,
        providerReauthorizationRequiredAfter: existing.infrastructureReadyAt ?? input.now,
      };
    }

    const [archive] = await tx
      .select()
      .from(founderRecoveryArchives)
      .where(
        and(
          eq(
            founderRecoveryArchives.id,
            retirement.recoveryArchiveId ?? "00000000-0000-0000-0000-000000000000",
          ),
          eq(founderRecoveryArchives.userId, input.userId),
          eq(founderRecoveryArchives.operatorId, sourceOperator.id),
          eq(founderRecoveryArchives.status, "verified"),
          eq(founderRecoveryArchives.restorableVerified, true),
          gt(founderRecoveryArchives.expiresAt, input.now),
          isNull(founderRecoveryArchives.deletedAt),
        ),
      )
      .orderBy(desc(founderRecoveryArchives.observedAt))
      .limit(1)
      .for("update");
    const [authoritativeDeletion] = archive
      ? await tx
          .select({ id: founderRecoveryArchiveDeletionReceipts.id })
          .from(founderRecoveryArchiveDeletionReceipts)
          .where(
            and(
              eq(founderRecoveryArchiveDeletionReceipts.archiveId, archive.id),
              eq(founderRecoveryArchiveDeletionReceipts.status, "completed"),
            ),
          )
          .limit(1)
      : [];
    const eligibleArchive = authoritativeDeletion ? null : archive;
    let restoredOperatorId = sourceOperator.id;
    if (!eligibleArchive) {
      await tx
        .update(operators)
        .set({ status: "archived", archivedAt: input.now, updatedAt: input.now })
        .where(eq(operators.id, sourceOperator.id));
      const [replacement] = await tx
        .insert(operators)
        .values({
          userId: input.userId,
          status: "active",
          externalActionPause: true,
          externalActionPauseReason: RESTORATION_PAUSE_REASON,
          externalActionPausedAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning({ id: operators.id });
      if (!replacement) throw new Error("New Operator environment could not be persisted.");
      restoredOperatorId = replacement.id;
      await tx.insert(operatorPreparations).values({
        operatorId: replacement.id,
        status: "awaiting_timezone",
        createdAt: input.now,
        updatedAt: input.now,
      });
      await tx.insert(operatorRuntimes).values({
        operatorId: replacement.id,
        status: "awaiting_timezone",
        transportState: "unknown",
        safetyState: "unknown",
        attemptCount: 0,
        createdAt: input.now,
        updatedAt: input.now,
      });
    } else {
      await tx
        .update(operators)
        .set({
          externalActionPause: true,
          externalActionPauseReason: RESTORATION_PAUSE_REASON,
          externalActionPausedAt: input.now,
          updatedAt: input.now,
        })
        .where(eq(operators.id, sourceOperator.id));
    }
    const runnerId = randomUUID();
    const leaseToken = randomUUID();
    const [restoration] = await tx
      .insert(founderOperatorRestorations)
      .values({
        userId: input.userId,
        sourceOperatorId: sourceOperator.id,
        restoredOperatorId,
        recoveryArchiveId: eligibleArchive?.id ?? null,
        sourceRetirementId: retirement.id,
        sourceEventId: event.id,
        mode: eligibleArchive ? "same_logical_operator" : "new_operator_environment",
        status: "in_progress",
        oldProviderResourceId: retirement.providerResourceId,
        oldProviderFirewallId: retirement.providerFirewallId,
        oldRuntimeIdentity: requiredText(
          retirement.retiredRuntimeIdentity,
          "retired runtime identity",
        ),
        attemptCount: 1,
        leaseToken,
        leaseExpiresAt: new Date(input.now.valueOf() + 5 * 60 * 1_000),
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning({ id: founderOperatorRestorations.id });
    if (!restoration) throw new Error("Returning Founder restoration was not claimed.");
    return {
      restorationId: restoration.id,
      leaseToken,
      userId: input.userId,
      sourceEventId: event.id,
      sourceOperatorId: sourceOperator.id,
      restoredOperatorId,
      sourceRetirementId: retirement.id,
      oldProviderResourceId: retirement.providerResourceId,
      oldProviderFirewallId: retirement.providerFirewallId,
      oldRuntimeIdentity: requiredText(
        retirement.retiredRuntimeIdentity,
        "retired runtime identity",
      ),
      oldEndpointUrl: sourceRunner?.endpointUrl ?? null,
      providerSubscriptionId: event.subscriptionId,
      providerOrderId: event.orderId,
      checkoutCorrelationId: event.checkoutCorrelationId,
      archive: eligibleArchive
        ? {
            id: eligibleArchive.id,
            storageObjectKey: requiredText(eligibleArchive.storageObjectKey, "archive object"),
            recoveryCredentialObjectKey: requiredText(
              eligibleArchive.recoveryCredentialObjectKey,
              "recovery credential",
            ),
            ciphertextDigest: requiredDigest(eligibleArchive.ciphertextDigest),
            recoveryCredentialDigest: requiredDigest(eligibleArchive.recoveryCredentialDigest),
            stateDigest: requiredDigest(eligibleArchive.stateDigest),
          }
        : null,
      runnerId,
      infrastructure: null,
      providerReauthorizationRequiredAfter: input.now,
    };
  });
}

async function persistProvisionedInfrastructure(
  prepared: PreparedRestoration,
  infrastructure: FounderRestorationInfrastructureIdentity,
  state: FounderRecoveryArchiveDurableState,
  now: Date,
  connection: DatabaseConnection,
): Promise<void> {
  await connection.db.transaction(async (tx) => {
    await lockFounderProductContractLifecycleInTransaction(tx, prepared.userId);
    await requireArchiveStillAuthoritative(tx, prepared, now);
    if (infrastructure.persistedRunner) {
      const [runner] = await tx
        .select({ id: runners.id })
        .from(runners)
        .where(
          and(
            eq(runners.id, infrastructure.runnerId),
            eq(runners.userId, prepared.userId),
            eq(runners.providerResourceId, infrastructure.providerResourceId),
            eq(runners.providerFirewallId, infrastructure.providerFirewallId),
            eq(runners.provisioningStatus, "ready"),
          ),
        )
        .limit(1)
        .for("update");
      if (!runner) throw new Error("Restoration Infrastructure readiness was not verified.");
    } else {
      await tx.insert(runners).values({
        id: infrastructure.runnerId,
        userId: prepared.userId,
        name: infrastructure.name,
        kind: "digitalocean",
        endpointUrl: infrastructure.endpointUrl,
        status: "online",
        provider: "digitalocean",
        providerResourceId: infrastructure.providerResourceId,
        providerFirewallId: infrastructure.providerFirewallId,
        region: infrastructure.region,
        sizeSlug: infrastructure.sizeSlug,
        image: infrastructure.image,
        provisioningStatus: "ready",
        provisioningOperationKey: infrastructure.operationTag,
        provisioningStartedAt: now,
        provisioningCompletedAt: now,
        createdAt: infrastructure.createdAt,
        updatedAt: now,
      });
    }
    await tx
      .update(operatorPreparations)
      .set({
        status: "ready",
        timezone: state.preparation.timezone,
        timezoneConfirmedAt: new Date(state.preparation.timezoneConfirmedAt),
        startedAt: now,
        completedAt: now,
        recoveryMessage: null,
        updatedAt: now,
      })
      .where(eq(operatorPreparations.operatorId, prepared.restoredOperatorId));
    await tx
      .update(operatorRuntimes)
      .set({
        // The replacement runtime itself is ready once its exact infrastructure
        // identity has been observed. The Operator-level external-action pause
        // remains authoritative, so provider authorization UIs can run while
        // every actual work seam continues to fail closed.
        status: "ready",
        transportState: "connected",
        safetyState: "verified",
        configRevision: state.runtime.configRevision,
        runtimeIdentity: infrastructure.runtimeIdentity,
        attemptCount: 1,
        startedAt: now,
        readyAt: now,
        recoveryMessage: null,
        failureCode: "provider_reauthorization_required",
        updatedAt: now,
      })
      .where(eq(operatorRuntimes.operatorId, prepared.restoredOperatorId));
    const [restoration] = await tx
      .update(founderOperatorRestorations)
      .set({
        newRunnerId: prepared.runnerId,
        status: "provider_reauthorization_required",
        newProviderResourceId: infrastructure.providerResourceId,
        newProviderFirewallId: infrastructure.providerFirewallId,
        newRuntimeIdentity: infrastructure.runtimeIdentity,
        archiveVerifiedAt: now,
        infrastructureReadyAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(founderOperatorRestorations.id, prepared.restorationId),
          eq(founderOperatorRestorations.leaseToken, prepared.leaseToken),
        ),
      )
      .returning({ id: founderOperatorRestorations.id });
    if (!restoration) throw new Error("Restoration Infrastructure lease was lost.");
  });
}

async function persistPendingInfrastructure(
  prepared: PreparedRestoration,
  infrastructure: FounderRestorationInfrastructureIdentity,
  now: Date,
  connection: DatabaseConnection,
): Promise<void> {
  if (!infrastructure.persistedRunner) {
    throw new Error("Pending restoration Infrastructure must be durably provider-owned.");
  }
  await connection.db.transaction(async (tx) => {
    await lockFounderProductContractLifecycleInTransaction(tx, prepared.userId);
    await requireArchiveStillAuthoritative(tx, prepared, now);
    const [runner] = await tx
      .select({ id: runners.id })
      .from(runners)
      .where(
        and(
          eq(runners.id, infrastructure.runnerId),
          eq(runners.userId, prepared.userId),
          eq(runners.providerResourceId, infrastructure.providerResourceId),
          eq(runners.providerFirewallId, infrastructure.providerFirewallId),
        ),
      )
      .limit(1)
      .for("update");
    if (!runner) throw new Error("Pending restoration Infrastructure identity was not verified.");
    const [restoration] = await tx
      .update(founderOperatorRestorations)
      .set({
        newRunnerId: infrastructure.runnerId,
        newProviderResourceId: infrastructure.providerResourceId,
        newProviderFirewallId: infrastructure.providerFirewallId,
        newRuntimeIdentity: infrastructure.runtimeIdentity,
        archiveVerifiedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(founderOperatorRestorations.id, prepared.restorationId),
          eq(founderOperatorRestorations.leaseToken, prepared.leaseToken),
        ),
      )
      .returning({ id: founderOperatorRestorations.id });
    if (!restoration) throw new Error("Pending restoration Infrastructure lease was lost.");
  });
}

async function completeRestoration(
  prepared: PreparedRestoration,
  infrastructure: FounderRestorationInfrastructureIdentity,
  now: Date,
  connection: DatabaseConnection,
): Promise<void> {
  await connection.db.transaction(async (tx) => {
    await lockFounderProductContractLifecycleInTransaction(tx, prepared.userId);
    await requireArchiveStillAuthoritative(tx, prepared, now);
    await tx
      .insert(founderProductEntitlements)
      .values({
        userId: prepared.userId,
        sourceEventId: prepared.sourceEventId,
        providerSubscriptionId: prepared.providerSubscriptionId,
        status: "verified",
        reconciledProviderStatus: "active",
        providerStateUpdatedAt: now,
        reconciledAt: now,
        retirementDueAt: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: founderProductEntitlements.userId,
        set: {
          sourceEventId: prepared.sourceEventId,
          providerSubscriptionId: prepared.providerSubscriptionId,
          status: "verified",
          reconciledProviderStatus: "active",
          providerStateUpdatedAt: now,
          reconciledAt: now,
          retirementDueAt: null,
          updatedAt: now,
        },
      });
    await tx
      .update(operatorRuntimes)
      .set({
        status: "ready",
        readyAt: now,
        recoveryMessage: null,
        failureCode: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(operatorRuntimes.operatorId, prepared.restoredOperatorId),
          eq(operatorRuntimes.runtimeIdentity, infrastructure.runtimeIdentity),
        ),
      );
    await tx
      .update(operators)
      .set({
        externalActionPause: false,
        externalActionPauseReason: null,
        externalActionPausedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(operators.id, prepared.restoredOperatorId),
          eq(operators.externalActionPauseReason, RESTORATION_PAUSE_REASON),
        ),
      );
    await tx
      .update(founderCommerceEvents)
      .set({
        applicationStatus: "applied",
        lastAttemptAt: now,
        appliedAt: now,
        lastErrorCode: null,
      })
      .where(eq(founderCommerceEvents.id, prepared.sourceEventId));
    const [restoration] = await tx
      .update(founderOperatorRestorations)
      .set({
        status: "completed",
        providersReadyAt: now,
        entitlementVerifiedAt: now,
        workResumedAt: now,
        failureCode: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(founderOperatorRestorations.id, prepared.restorationId),
          eq(founderOperatorRestorations.leaseToken, prepared.leaseToken),
        ),
      )
      .returning({ id: founderOperatorRestorations.id });
    if (!restoration) throw new Error("Returning Founder completion lease was lost.");
  });
}

async function refundAndClose(
  prepared: PreparedRestoration,
  infrastructure: FounderRestorationInfrastructureIdentity | null,
  failureCode: string,
  now: Date,
  dependencies: { provider: FounderReturningRestorationProvider },
  connection: DatabaseConnection,
): Promise<void> {
  if (infrastructure) {
    const cleanup = await dependencies.provider.retireRestorationInfrastructure(infrastructure);
    if (!cleanup.dropletAbsent || !cleanup.firewallAbsent) {
      throw new Error("Partial restoration infrastructure absence was not verified.");
    }
  }
  const refund = await dependencies.provider.refundRestorationPayment({
    subscriptionId: prepared.providerSubscriptionId,
    orderId: prepared.providerOrderId,
  });
  if (!refund.fullRefundConfirmed) throw new Error("Full restoration refund was not confirmed.");
  await connection.db.transaction(async (tx) => {
    await lockFounderProductContractLifecycleInTransaction(tx, prepared.userId);
    await tx
      .update(founderCheckoutCorrelations)
      .set({
        status: "closed",
        refundRequestedAt: now,
        refundAttemptCount: 1,
        refundLeaseToken: null,
        refundLeaseExpiresAt: null,
        refundLastErrorCode: null,
        refundedAt: now,
        closedAt: now,
        closureReason: "payment_without_access_refunded",
      })
      .where(eq(founderCheckoutCorrelations.id, prepared.checkoutCorrelationId));
    await tx
      .insert(founderProductEntitlements)
      .values({
        userId: prepared.userId,
        sourceEventId: prepared.sourceEventId,
        providerSubscriptionId: prepared.providerSubscriptionId,
        status: "refunded",
        reconciledProviderStatus: "refunded",
        providerStateUpdatedAt: now,
        reconciledAt: now,
        retirementDueAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: founderProductEntitlements.userId,
        set: {
          sourceEventId: prepared.sourceEventId,
          providerSubscriptionId: prepared.providerSubscriptionId,
          status: "refunded",
          reconciledProviderStatus: "refunded",
          providerStateUpdatedAt: now,
          reconciledAt: now,
          retirementDueAt: now,
          updatedAt: now,
        },
      });
    await tx
      .update(founderCommerceEvents)
      .set({
        applicationStatus: "ignored",
        lastAttemptAt: now,
        appliedAt: now,
        lastErrorCode: null,
      })
      .where(eq(founderCommerceEvents.id, prepared.sourceEventId));
    if (infrastructure) {
      await tx
        .update(runners)
        .set({ status: "deleted", provisioningStatus: "deleted", deletedAt: now, updatedAt: now })
        .where(eq(runners.id, prepared.runnerId));
    }
    const [restoration] = await tx
      .update(founderOperatorRestorations)
      .set({
        status: "refunded",
        ...(infrastructure
          ? {
              newProviderResourceId: infrastructure.providerResourceId,
              newProviderFirewallId: infrastructure.providerFirewallId,
              newRuntimeIdentity: infrastructure.runtimeIdentity,
            }
          : {}),
        refundConfirmedAt: now,
        cleanupConfirmedAt: now,
        failureCode,
        updatedAt: now,
      })
      .where(
        and(
          eq(founderOperatorRestorations.id, prepared.restorationId),
          eq(founderOperatorRestorations.leaseToken, prepared.leaseToken),
        ),
      )
      .returning({ id: founderOperatorRestorations.id });
    if (!restoration) throw new Error("Returning Founder refund lease was lost.");
  });
}

async function requireArchiveStillAuthoritative(
  tx: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
  prepared: PreparedRestoration,
  now: Date,
): Promise<void> {
  if (!prepared.archive) throw new Error("Verified Recovery Archive authority is required.");
  const [archive] = await tx
    .select({ id: founderRecoveryArchives.id })
    .from(founderRecoveryArchives)
    .where(
      and(
        eq(founderRecoveryArchives.id, prepared.archive.id),
        eq(founderRecoveryArchives.status, "verified"),
        eq(founderRecoveryArchives.restorableVerified, true),
        gt(founderRecoveryArchives.expiresAt, now),
        isNull(founderRecoveryArchives.deletedAt),
      ),
    )
    .limit(1)
    .for("update");
  const [deletion] = await tx
    .select({ id: founderRecoveryArchiveDeletionReceipts.id })
    .from(founderRecoveryArchiveDeletionReceipts)
    .where(
      and(
        eq(founderRecoveryArchiveDeletionReceipts.archiveId, prepared.archive.id),
        eq(founderRecoveryArchiveDeletionReceipts.status, "completed"),
      ),
    )
    .limit(1);
  if (!archive || deletion) {
    throw new Error("Recovery Archive deletion or expiry remains authoritative.");
  }
}

function assertNewInfrastructureIdentity(
  prepared: PreparedRestoration,
  infrastructure: FounderRestorationInfrastructureIdentity,
): void {
  const endpoint = infrastructure.endpointUrl;
  if (
    !infrastructure.providerResourceId ||
    !infrastructure.providerFirewallId ||
    !infrastructure.runtimeIdentity ||
    infrastructure.providerResourceId === prepared.oldProviderResourceId ||
    infrastructure.providerFirewallId === prepared.oldProviderFirewallId ||
    infrastructure.runtimeIdentity === prepared.oldRuntimeIdentity ||
    endpoint === prepared.oldEndpointUrl ||
    !/^bruno-deploy-[0-9a-f]{32}$/.test(infrastructure.operationTag)
  ) {
    throw new Error("Restoration must use a new exact infrastructure identity.");
  }
}

function restorationOutcome(
  mode: FounderReturningRestorationOutcome["mode"],
  provider: FounderReturningRestorationProvider,
  input: {
    status?: "restoring" | "provider_reauthorization_required" | "refunded";
    fullRefundConfirmed: boolean;
    cleanupVerified: boolean;
  },
): FounderReturningRestorationOutcome {
  return {
    mode,
    status: input.status ?? "refunded",
    logicalOperatorPreserved: mode === "same_logical_operator",
    newInfrastructureIdentity: mode === "same_logical_operator" && input.status !== "restoring",
    providerReauthorizationRequired: true,
    providerReauthorizationCompleted: false,
    workResumed: false,
    fullRefundConfirmed: input.fullRefundConfirmed,
    cleanupVerified: input.cleanupVerified,
    archiveDeletionAuthoritative: true,
    providerCalls: provider.calls(),
  };
}

function requiredText(value: string | null, label: string): string {
  if (!value) throw new Error(`Verified Recovery Archive ${label} is unavailable.`);
  return value;
}

function requiredDigest(value: string | null): `sha256:${string}` {
  if (!value || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error("Verified Recovery Archive digest is unavailable.");
  }
  return value as `sha256:${string}`;
}

function restorationFailureCode(error: unknown): string {
  if (error instanceof Error && /deletion|expiry/i.test(error.message)) {
    return "archive_authority_lost";
  }
  if (error instanceof Error && /reauthorization/i.test(error.message)) {
    return "provider_reauthorization_failed";
  }
  return "restoration_failed";
}
