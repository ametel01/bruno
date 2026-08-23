import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, lte, notExists, or } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderCheckoutCorrelations,
  founderCommerceEvents,
  founderInfrastructureRetirements,
  founderProductEntitlements,
  operators,
} from "@/src/server/db/schema";
import { founderProductContractDigest } from "@/src/server/founder-product-contract/digest";
import {
  executeFounderInfrastructureRetirement,
  type FounderInfrastructureRetirementProvider,
} from "@/src/server/founder-product-contract/infrastructure-retirement";
import { lockFounderProductContractLifecycleInTransaction } from "@/src/server/founder-product-contract/operator-authority";
import {
  findNextFounderGeneralReleaseDeadlineUser,
  findNextFounderGeneralReleaseRetirementUser,
  reconcileFounderGeneralReleaseDeadlineForUser,
} from "@/src/server/founder-product-contract/initial-general-release";
import type { LemonSqueezyCommerceProvider } from "./lemon-squeezy-provider";
import { reconcileFounderCommerceReceipt } from "./founder-commerce";

const REFUND_LEASE_MILLISECONDS = 5 * 60 * 1_000;
const ENTITLEMENT_PAUSE_REASON = "Product Entitlement does not authorize new work.";

type RefundClaim = {
  id: string;
  userId: string;
  subscriptionId: string;
  orderId: string;
  leaseToken: string;
};

type Transaction = Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0];

export type FounderCommerceReconciliationResult = {
  processed: number;
  outcome:
    | "idle"
    | "receipt_applied"
    | "receipt_pending"
    | "refund_confirmed"
    | "refund_retrying"
    | "retirement_completed"
    | "retirement_retrying"
    | "retirement_superseded"
    | "general_release_deadline_reconciled";
};

export async function reconcileNextFounderCommerce(input: {
  now: Date;
  applicationRevision: string;
  commerceProvider: LemonSqueezyCommerceProvider;
  retirementProvider: FounderInfrastructureRetirementProvider;
  createConnection?: () => DatabaseConnection;
}): Promise<FounderCommerceReconciliationResult> {
  const connection = input.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !input.createConnection;
  try {
    const [pendingReceipt] = await connection.db
      .select({ id: founderCommerceEvents.id })
      .from(founderCommerceEvents)
      .where(eq(founderCommerceEvents.applicationStatus, "pending"))
      .orderBy(asc(founderCommerceEvents.recordedAt))
      .limit(1);
    if (pendingReceipt) {
      const outcome = await reconcileFounderCommerceReceipt({
        receiptId: pendingReceipt.id,
        now: input.now,
        provider: input.commerceProvider,
        createConnection: () => connection,
      });
      if (outcome === "applied" || outcome === "ignored") {
        return { processed: 1, outcome: "receipt_applied" };
      }
    }

    const claim = await claimRefund(connection, input.now);
    if (claim) {
      const confirmed = await executeRefundClaim(connection, claim, input);
      return {
        processed: 1,
        outcome: confirmed ? "refund_confirmed" : "refund_retrying",
      };
    }

    const deadlineUser = await findNextFounderGeneralReleaseDeadlineUser(input.now, connection);
    if (deadlineUser) {
      await reconcileFounderGeneralReleaseDeadlineForUser(deadlineUser, input.now, {
        createConnection: () => connection,
      });
      return { processed: 1, outcome: "general_release_deadline_reconciled" };
    }

    const generalReleaseRetirementUser = await findNextFounderGeneralReleaseRetirementUser(
      input.now,
      connection,
    );
    if (generalReleaseRetirementUser) {
      try {
        await executeFounderInfrastructureRetirement(
          {
            action: "infrastructure_retirement",
            runId: `general-release:${generalReleaseRetirementUser}`,
            userId: generalReleaseRetirementUser,
            now: input.now,
          },
          { providers: input.retirementProvider, applicationRevision: input.applicationRevision },
          connection,
        );
        return { processed: 1, outcome: "retirement_completed" };
      } catch {
        return { processed: 1, outcome: "retirement_retrying" };
      }
    }

    const [retirement] = await connection.db
      .select({
        userId: founderCheckoutCorrelations.userId,
        id: founderCheckoutCorrelations.id,
        generation: founderCheckoutCorrelations.generation,
      })
      .from(founderCheckoutCorrelations)
      .where(
        and(
          eq(founderCheckoutCorrelations.status, "closed"),
          eq(founderCheckoutCorrelations.closureReason, "payment_without_access_refunded"),
          notExists(
            connection.db
              .select({ id: founderInfrastructureRetirements.id })
              .from(founderInfrastructureRetirements)
              .where(
                and(
                  eq(founderInfrastructureRetirements.userId, founderCheckoutCorrelations.userId),
                  eq(founderInfrastructureRetirements.status, "completed"),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(founderCheckoutCorrelations.closedAt))
      .limit(1);
    if (retirement) {
      const superseded = await connection.db.transaction(async (tx) => {
        await lockFounderProductContractLifecycleInTransaction(tx, retirement.userId);
        const authority = await readCurrentEntitlementAuthority(tx, retirement.userId);
        if (!authority || authority.generation <= retirement.generation) return false;
        await tx
          .update(founderCheckoutCorrelations)
          .set({ closureReason: "payment_without_access_refunded_superseded" })
          .where(
            and(
              eq(founderCheckoutCorrelations.id, retirement.id),
              eq(founderCheckoutCorrelations.closureReason, "payment_without_access_refunded"),
            ),
          );
        return true;
      });
      if (superseded) return { processed: 1, outcome: "retirement_superseded" };
      try {
        await executeFounderInfrastructureRetirement(
          {
            action: "infrastructure_retirement",
            runId: `commerce-refund:${retirement.id}`,
            userId: retirement.userId,
            now: input.now,
          },
          { providers: input.retirementProvider, applicationRevision: input.applicationRevision },
          connection,
        );
        return { processed: 1, outcome: "retirement_completed" };
      } catch {
        return { processed: 1, outcome: "retirement_retrying" };
      }
    }
    return {
      processed: pendingReceipt ? 1 : 0,
      outcome: pendingReceipt ? "receipt_pending" : "idle",
    };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

async function claimRefund(connection: DatabaseConnection, now: Date): Promise<RefundClaim | null> {
  return connection.db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(founderCheckoutCorrelations)
      .where(
        or(
          and(
            eq(founderCheckoutCorrelations.status, "consumed"),
            lte(founderCheckoutCorrelations.reconciliationDueAt, now),
          ),
          and(
            eq(founderCheckoutCorrelations.status, "refund_pending"),
            or(
              isNull(founderCheckoutCorrelations.refundLeaseExpiresAt),
              lte(founderCheckoutCorrelations.refundLeaseExpiresAt, now),
            ),
          ),
        ),
      )
      .orderBy(asc(founderCheckoutCorrelations.reconciliationDueAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate?.providerSubscriptionId || !candidate.providerOrderId) return null;
    await lockFounderProductContractLifecycleInTransaction(tx, candidate.userId);
    const authority = await readCurrentEntitlementAuthority(tx, candidate.userId);
    if (authority?.checkoutCorrelationId === candidate.id && authority.status === "verified") {
      return null;
    }
    const superseded = authority !== null && authority.generation > candidate.generation;
    const leaseToken = randomUUID();
    await tx
      .update(founderCheckoutCorrelations)
      .set({
        status: "refund_pending",
        refundRequestedAt: candidate.refundRequestedAt ?? now,
        refundLeaseToken: leaseToken,
        refundLeaseExpiresAt: new Date(now.valueOf() + REFUND_LEASE_MILLISECONDS),
        refundAttemptCount: candidate.refundAttemptCount + 1,
        refundLastErrorCode: null,
      })
      .where(eq(founderCheckoutCorrelations.id, candidate.id));
    if (!superseded) {
      await tx
        .update(operators)
        .set({
          externalActionPause: true,
          externalActionPauseReason: ENTITLEMENT_PAUSE_REASON,
          externalActionPausedAt: now,
          updatedAt: now,
        })
        .where(eq(operators.userId, candidate.userId));
    }
    return {
      id: candidate.id,
      userId: candidate.userId,
      subscriptionId: candidate.providerSubscriptionId,
      orderId: candidate.providerOrderId,
      leaseToken,
    };
  });
}

async function executeRefundClaim(
  connection: DatabaseConnection,
  claim: RefundClaim,
  input: {
    now: Date;
    applicationRevision: string;
    commerceProvider: LemonSqueezyCommerceProvider;
    retirementProvider: FounderInfrastructureRetirementProvider;
  },
): Promise<boolean> {
  try {
    let order = await input.commerceProvider.readOrder({ orderId: claim.orderId });
    await input.commerceProvider.cancelSubscription({ subscriptionId: claim.subscriptionId });
    if (!isFullRefund(order)) {
      try {
        order = await input.commerceProvider.refundOrder({ orderId: claim.orderId });
      } catch {
        order = await input.commerceProvider.readOrder({ orderId: claim.orderId });
      }
    }
    if (!isFullRefund(order)) throw new Error("refund_unconfirmed");

    const closure = await connection.db.transaction(async (tx) => {
      await lockFounderProductContractLifecycleInTransaction(tx, claim.userId);
      const [attempt] = await tx
        .select()
        .from(founderCheckoutCorrelations)
        .where(eq(founderCheckoutCorrelations.id, claim.id))
        .limit(1)
        .for("update");
      if (attempt?.status !== "refund_pending" || attempt.refundLeaseToken !== claim.leaseToken) {
        return { closed: false, retireInfrastructure: false };
      }
      const authority = await readCurrentEntitlementAuthority(tx, claim.userId);
      const superseded = authority !== null && authority.generation > attempt.generation;
      const [source] = await tx
        .select({ id: founderCommerceEvents.id })
        .from(founderCommerceEvents)
        .where(eq(founderCommerceEvents.checkoutCorrelationId, claim.id))
        .orderBy(desc(founderCommerceEvents.occurredAt))
        .limit(1);
      if (!source) throw new Error("refund_receipt_missing");
      await tx
        .update(founderCheckoutCorrelations)
        .set({
          status: "closed",
          refundLeaseToken: null,
          refundLeaseExpiresAt: null,
          refundedAt: input.now,
          closedAt: input.now,
          closureReason: superseded
            ? "payment_without_access_refunded_superseded"
            : "payment_without_access_refunded",
          refundLastErrorCode: null,
        })
        .where(eq(founderCheckoutCorrelations.id, claim.id));
      if (!superseded) {
        await tx
          .insert(founderProductEntitlements)
          .values({
            userId: claim.userId,
            sourceEventId: source.id,
            providerSubscriptionId: claim.subscriptionId,
            status: "refunded",
            reconciledProviderStatus: "refunded",
            providerStateUpdatedAt: input.now,
            reconciledAt: input.now,
            retirementDueAt: input.now,
            updatedAt: input.now,
          })
          .onConflictDoUpdate({
            target: founderProductEntitlements.userId,
            set: {
              sourceEventId: source.id,
              providerSubscriptionId: claim.subscriptionId,
              status: "refunded",
              reconciledProviderStatus: "refunded",
              providerStateUpdatedAt: input.now,
              reconciledAt: input.now,
              retirementDueAt: input.now,
              updatedAt: input.now,
            },
          });
      }
      return { closed: true, retireInfrastructure: !superseded };
    });
    if (!closure.closed || !closure.retireInfrastructure) return true;
    try {
      await executeFounderInfrastructureRetirement(
        {
          action: "infrastructure_retirement",
          runId: `commerce-refund:${claim.id}`,
          userId: claim.userId,
          now: input.now,
        },
        { providers: input.retirementProvider, applicationRevision: input.applicationRevision },
        connection,
      );
    } catch {
      // The closed refunded attempt remains terminal; the next cron retries exact retirement.
    }
    return true;
  } catch (error) {
    await connection.db
      .update(founderCheckoutCorrelations)
      .set({
        refundLeaseToken: null,
        refundLeaseExpiresAt: null,
        refundLastErrorCode: sanitizedRefundError(error),
      })
      .where(
        and(
          eq(founderCheckoutCorrelations.id, claim.id),
          eq(founderCheckoutCorrelations.status, "refund_pending"),
          eq(founderCheckoutCorrelations.refundLeaseToken, claim.leaseToken),
        ),
      );
    return false;
  }
}

async function readCurrentEntitlementAuthority(tx: Transaction, userId: string) {
  const [entitlement] = await tx
    .select({
      status: founderProductEntitlements.status,
      checkoutCorrelationId: founderCommerceEvents.checkoutCorrelationId,
    })
    .from(founderProductEntitlements)
    .innerJoin(
      founderCommerceEvents,
      eq(founderCommerceEvents.id, founderProductEntitlements.sourceEventId),
    )
    .where(eq(founderProductEntitlements.userId, userId))
    .limit(1);
  if (!entitlement) return null;
  const [correlation] = await tx
    .select({ generation: founderCheckoutCorrelations.generation })
    .from(founderCheckoutCorrelations)
    .where(eq(founderCheckoutCorrelations.id, entitlement.checkoutCorrelationId))
    .limit(1);
  if (!correlation) throw new Error("Current commerce authority disappeared.");
  return { ...entitlement, generation: correlation.generation };
}

function isFullRefund(order: { status: string; refundedAmount: number; total: number }): boolean {
  return order.status === "refunded" && order.refundedAmount >= order.total;
}

function sanitizedRefundError(error: unknown): string {
  return founderProductContractDigest(
    error instanceof Error && error.message === "refund_unconfirmed"
      ? "refund_unconfirmed"
      : "provider_refund_unavailable",
  );
}
