import "server-only";

import { randomUUID } from "node:crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderCommerceEvents,
  founderCommerceLifecycleReceipts,
  founderProductEntitlements,
  operatorDeletionCommerceCancellations,
  operatorDeletionReceipts,
  operators,
} from "@/src/server/db/schema";
import { lockFounderProductContractLifecycleInTransaction } from "@/src/server/founder-product-contract/operator-authority";
import {
  LemonSqueezyApiProvider,
  type ReconciledLemonSqueezySubscription,
  readLemonSqueezyConfig,
} from "./lemon-squeezy-provider";

export type FounderAccountClosureCommerceObservation = ReconciledLemonSqueezySubscription;

export type FounderAccountClosureCommerceDependencies = {
  createConnection?: () => DatabaseConnection;
  cancelSubscription?: (subscriptionId: string) => Promise<void>;
  readSubscription?: (subscriptionId: string) => Promise<FounderAccountClosureCommerceObservation>;
  now?: () => Date;
};

export async function reconcileFounderAccountClosureCommerceCancellation(
  requestId: string,
  dependencies: FounderAccountClosureCommerceDependencies = {},
): Promise<void> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const observedAt = dependencies.now?.() ?? new Date();
  try {
    const authorities = await connection.db
      .select({
        cancellationId: operatorDeletionCommerceCancellations.id,
        providerSubscriptionId: operatorDeletionCommerceCancellations.providerSubscriptionId,
        status: operatorDeletionCommerceCancellations.status,
        userId: operators.userId,
      })
      .from(operatorDeletionCommerceCancellations)
      .innerJoin(operators, eq(operators.id, operatorDeletionCommerceCancellations.operatorId))
      .where(
        and(
          eq(operatorDeletionCommerceCancellations.requestId, requestId),
          ne(operatorDeletionCommerceCancellations.status, "succeeded"),
        ),
      );
    for (const authority of authorities) {
      let observation: FounderAccountClosureCommerceObservation | null = null;
      try {
        const provider = defaultProvider(dependencies);
        await provider.cancelSubscription(authority.providerSubscriptionId);
        observation = await provider.readSubscription(authority.providerSubscriptionId);
        if (
          observation.subscriptionId !== authority.providerSubscriptionId ||
          observation.status !== "cancelled"
        ) {
          observation = null;
        }
      } catch {
        observation = null;
      }

      await connection.db.transaction(async (tx) => {
        await lockFounderProductContractLifecycleInTransaction(tx, authority.userId);
        const [current] = await tx
          .select()
          .from(operatorDeletionCommerceCancellations)
          .where(eq(operatorDeletionCommerceCancellations.id, authority.cancellationId))
          .limit(1)
          .for("update");
        if (!current || current.status === "succeeded") return;
        const [currentEntitlement] = await tx
          .select({
            sourceEventId: founderProductEntitlements.sourceEventId,
            providerSubscriptionId: founderProductEntitlements.providerSubscriptionId,
            status: founderProductEntitlements.status,
            providerStateUpdatedAt: founderProductEntitlements.providerStateUpdatedAt,
          })
          .from(founderProductEntitlements)
          .where(eq(founderProductEntitlements.userId, authority.userId))
          .limit(1)
          .for("update");
        const observationUpdatedAt = observation ? new Date(observation.updatedAt) : null;
        const canonicalCandidates = observation
          ? await tx
              .select({
                eventId: founderCommerceEvents.id,
                eventSubscriptionId: founderCommerceEvents.providerSubscriptionId,
                eventOrderId: founderCommerceEvents.providerOrderId,
                eventStatus: founderCommerceEvents.applicationStatus,
                receiptId: founderCommerceLifecycleReceipts.id,
                receiptSubscriptionId: founderCommerceLifecycleReceipts.providerSubscriptionId,
                effectiveAt: founderCommerceLifecycleReceipts.effectiveAt,
                occurredAt: founderCommerceLifecycleReceipts.occurredAt,
              })
              .from(founderCommerceEvents)
              .innerJoin(
                founderCommerceLifecycleReceipts,
                and(
                  eq(founderCommerceLifecycleReceipts.sourceEventId, founderCommerceEvents.id),
                  eq(founderCommerceLifecycleReceipts.kind, "cancellation"),
                ),
              )
              .where(
                and(
                  eq(founderCommerceEvents.userId, authority.userId),
                  eq(
                    founderCommerceEvents.providerSubscriptionId,
                    authority.providerSubscriptionId,
                  ),
                  eq(founderCommerceEvents.providerOrderId, observation.orderId),
                  eq(founderCommerceEvents.applicationStatus, "applied"),
                  eq(
                    founderCommerceLifecycleReceipts.providerSubscriptionId,
                    authority.providerSubscriptionId,
                  ),
                ),
              )
              .orderBy(desc(founderCommerceLifecycleReceipts.createdAt))
          : [];
        const canonical = canonicalCandidates.find(
          (candidate) =>
            observationUpdatedAt &&
            candidate.occurredAt >= observationUpdatedAt &&
            candidate.effectiveAt?.valueOf() ===
              (observation?.endsAt
                ? new Date(observation.endsAt).valueOf()
                : candidate.occurredAt.valueOf()) &&
            (currentEntitlement?.providerSubscriptionId === authority.providerSubscriptionId
              ? (currentEntitlement.status === "cancelled" ||
                  currentEntitlement.status === "refunded" ||
                  currentEntitlement.status === "unpaid") &&
                currentEntitlement.sourceEventId === candidate.eventId &&
                currentEntitlement.providerStateUpdatedAt.valueOf() ===
                  candidate.occurredAt.valueOf()
              : candidate.occurredAt >= current.createdAt),
        );
        const confirmed = Boolean(
          observation &&
            observationUpdatedAt &&
            Number.isFinite(observationUpdatedAt.valueOf()) &&
            canonical &&
            canonical.eventSubscriptionId === observation.subscriptionId &&
            canonical.eventOrderId === observation.orderId &&
            canonical.eventStatus === "applied" &&
            canonical.receiptSubscriptionId === observation.subscriptionId &&
            canonical.occurredAt >= observationUpdatedAt,
        );
        if (!confirmed || !canonical || !observation) {
          await tx
            .update(operatorDeletionCommerceCancellations)
            .set({
              status: "failed",
              attemptCount: current.attemptCount + 1,
              lastAttemptAt: observedAt,
              confirmedAt: null,
              errorCode: "commerce_cancellation_unconfirmed",
              updatedAt: observedAt,
            })
            .where(eq(operatorDeletionCommerceCancellations.id, current.id));
          return;
        }

        await tx
          .update(operatorDeletionCommerceCancellations)
          .set({
            status: "succeeded",
            attemptCount: current.attemptCount + 1,
            lastAttemptAt: observedAt,
            confirmedAt: observedAt,
            errorCode: null,
            updatedAt: observedAt,
          })
          .where(eq(operatorDeletionCommerceCancellations.id, current.id));
        await tx
          .insert(operatorDeletionReceipts)
          .values({
            id: randomUUID(),
            requestId,
            operatorId: current.operatorId,
            stage: "commerce_cancellation",
            occurredAt: observedAt,
            details: {
              provider: "lemon_squeezy",
              outcome: "subscription_cancellation_confirmed",
              providerStatus: observation.status,
              commerceLifecycleReceiptId: canonical.receiptId,
              sourceEventId: canonical.eventId,
              effectiveAt: canonical.effectiveAt?.toISOString(),
              productEntitlementChanged: false,
              refundStarted: false,
            },
            createdAt: observedAt,
          })
          .onConflictDoNothing({
            target: [operatorDeletionReceipts.requestId, operatorDeletionReceipts.stage],
          });
      });
    }
  } finally {
    if (ownsConnection) await connection.close();
  }
}

function defaultProvider(dependencies: FounderAccountClosureCommerceDependencies): {
  cancelSubscription: (subscriptionId: string) => Promise<void>;
  readSubscription: (subscriptionId: string) => Promise<FounderAccountClosureCommerceObservation>;
} {
  if (dependencies.cancelSubscription && dependencies.readSubscription) {
    return {
      cancelSubscription: dependencies.cancelSubscription,
      readSubscription: dependencies.readSubscription,
    };
  }
  const config = readLemonSqueezyConfig();
  if (!config) throw new Error("Commerce provider is not configured.");
  const provider = new LemonSqueezyApiProvider({ config });
  return {
    cancelSubscription: (subscriptionId) => provider.cancelSubscription({ subscriptionId }),
    readSubscription: (subscriptionId) => provider.readSubscription({ subscriptionId }),
  };
}
