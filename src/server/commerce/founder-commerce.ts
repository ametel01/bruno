import "server-only";

import { randomBytes } from "node:crypto";
import { and, desc, eq, or } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderCheckoutCorrelations,
  founderCommerceEvents,
  founderInfrastructureRetirements,
  founderProductEntitlements,
  operators,
} from "@/src/server/db/schema";
import { founderEntitlementPolicy } from "@/src/server/founder-product-contract/entitlement";
import { requireFounderGeneralReleasePurchaseDecisionInTransaction } from "@/src/server/founder-product-contract/initial-general-release";
import {
  lockFounderProductContractLifecycleInTransaction,
  requireActiveFounderOperatorAuthorityInTransaction,
} from "@/src/server/founder-product-contract/operator-authority";
import { founderProductContractDigest } from "@/src/server/founder-product-contract/digest";
import type {
  LemonSqueezyCommerceProvider,
  LemonSqueezyCommerceStatus,
  ReconciledLemonSqueezyOrder,
  ReconciledLemonSqueezySubscription,
} from "./lemon-squeezy-provider";
import type { VerifiedLemonSqueezyWebhook } from "./lemon-squeezy-webhook";

const CHECKOUT_LIFETIME_MILLISECONDS = 60 * 60 * 1_000;
const ENTITLEMENT_PAUSE_REASON = "Product Entitlement does not authorize new work.";

type Transaction = Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0];

export type FounderCommerceStatusDto =
  | { state: "not_started" }
  | { state: "confirming_payment"; reconciliationDueAt: string | null }
  | {
      state: "entitled";
      status: "verified" | "past_due" | "cancelled";
      retirementDueAt: string | null;
    }
  | {
      state: "payment_refunded";
      refundConfirmedAt: string;
      cleanup: "required" | "in_progress" | "completed";
    }
  | { state: "payment_failed"; reason: "unpaid" | "expired" | "refunded" };

export async function createFounderCheckout(input: {
  userId: string;
  appUrl: string;
  now: Date;
  provider: LemonSqueezyCommerceProvider;
  createConnection?: () => DatabaseConnection;
}): Promise<{ checkoutUrl: string }> {
  const connection = input.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !input.createConnection;
  const checkoutCorrelation = randomBytes(32).toString("base64url");
  const expiresAt = new Date(input.now.valueOf() + CHECKOUT_LIFETIME_MILLISECONDS);
  try {
    const correlationId = await connection.db.transaction(async (tx) => {
      await lockFounderProductContractLifecycleInTransaction(tx, input.userId);
      await requireActiveFounderOperatorAuthorityInTransaction(tx, input.userId);
      await requireFounderGeneralReleasePurchaseDecisionInTransaction(tx, input.userId, input.now);
      const [latest] = await tx
        .select({ generation: founderCheckoutCorrelations.generation })
        .from(founderCheckoutCorrelations)
        .where(eq(founderCheckoutCorrelations.userId, input.userId))
        .orderBy(desc(founderCheckoutCorrelations.generation))
        .limit(1);
      const [created] = await tx
        .insert(founderCheckoutCorrelations)
        .values({
          userId: input.userId,
          correlationDigest: founderProductContractDigest(checkoutCorrelation),
          generation: (latest?.generation ?? 0) + 1,
          createdAt: input.now,
          expiresAt,
        })
        .returning({ id: founderCheckoutCorrelations.id });
      if (!created) throw new Error("Checkout Correlation could not be persisted.");
      return created.id;
    });
    const redirectUrl = new URL("/operator/payment", input.appUrl).toString();
    const checkout = await input.provider.createCheckout({
      checkoutCorrelation,
      redirectUrl,
      expiresAt: expiresAt.toISOString(),
    });
    const updated = await connection.db
      .update(founderCheckoutCorrelations)
      .set({ providerCheckoutId: checkout.checkoutId })
      .where(
        and(
          eq(founderCheckoutCorrelations.id, correlationId),
          eq(founderCheckoutCorrelations.status, "pending"),
        ),
      )
      .returning({ id: founderCheckoutCorrelations.id });
    if (updated.length !== 1) throw new Error("Checkout Correlation is no longer pending.");
    return { checkoutUrl: checkout.checkoutUrl };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function getFounderCommerceStatusForUser(
  userId: string,
  dependencies: { createConnection?: () => DatabaseConnection } = {},
): Promise<FounderCommerceStatusDto> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const [[attempt], [entitlement], [retirement]] = await Promise.all([
      connection.db
        .select()
        .from(founderCheckoutCorrelations)
        .where(eq(founderCheckoutCorrelations.userId, userId))
        .orderBy(desc(founderCheckoutCorrelations.generation))
        .limit(1),
      connection.db
        .select()
        .from(founderProductEntitlements)
        .where(eq(founderProductEntitlements.userId, userId))
        .limit(1),
      connection.db
        .select({ status: founderInfrastructureRetirements.status })
        .from(founderInfrastructureRetirements)
        .where(eq(founderInfrastructureRetirements.userId, userId))
        .orderBy(desc(founderInfrastructureRetirements.updatedAt))
        .limit(1),
    ]);
    if (
      attempt?.status === "pending" ||
      attempt?.status === "consumed" ||
      attempt?.status === "refund_pending"
    ) {
      return {
        state: "confirming_payment",
        reconciliationDueAt: attempt.reconciliationDueAt?.toISOString() ?? null,
      };
    }
    if (attempt?.status === "closed" && attempt.refundedAt) {
      return {
        state: "payment_refunded",
        refundConfirmedAt: attempt.refundedAt.toISOString(),
        cleanup: retirement
          ? retirement.status === "completed"
            ? "completed"
            : "in_progress"
          : "required",
      };
    }
    if (!entitlement) return { state: "not_started" };
    if (
      entitlement.status === "verified" ||
      entitlement.status === "past_due" ||
      entitlement.status === "cancelled"
    ) {
      return {
        state: "entitled",
        status: entitlement.status,
        retirementDueAt: entitlement.retirementDueAt?.toISOString() ?? null,
      };
    }
    return { state: "payment_failed", reason: entitlement.status };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function recordFounderCommerceWebhook(input: {
  webhook: VerifiedLemonSqueezyWebhook;
  recordedAt: Date;
  createConnection?: () => DatabaseConnection;
}): Promise<{ receiptId: string; userId: string; terminal: boolean; duplicate: boolean }> {
  const connection = input.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !input.createConnection;
  try {
    return await connection.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(founderCommerceEvents)
        .where(eq(founderCommerceEvents.providerEventId, input.webhook.derivedDeliveryKey))
        .limit(1);
      if (existing) {
        assertSameReceipt(existing, input.webhook);
        const [correlation] = await tx
          .select({ status: founderCheckoutCorrelations.status })
          .from(founderCheckoutCorrelations)
          .where(eq(founderCheckoutCorrelations.id, existing.checkoutCorrelationId))
          .limit(1);
        return {
          receiptId: existing.id,
          userId: existing.userId,
          terminal: correlation?.status === "closed" || correlation?.status === "refund_pending",
          duplicate: true,
        };
      }

      const [correlation] = await findCheckoutCorrelation(tx, input.webhook);
      if (!correlation) throw new Error("Checkout Correlation was not found.");
      await lockFounderProductContractLifecycleInTransaction(tx, correlation.userId);
      const [locked] = await tx
        .select()
        .from(founderCheckoutCorrelations)
        .where(eq(founderCheckoutCorrelations.id, correlation.id))
        .limit(1)
        .for("update");
      if (!locked) throw new Error("Checkout Correlation was not found.");
      const eventOccurredAt = new Date(input.webhook.occurredAt);
      if (locked.status === "pending") {
        if (!input.webhook.checkoutCorrelation || eventOccurredAt > locked.expiresAt) {
          throw new Error("Checkout Correlation was not valid when payment occurred.");
        }
        await tx
          .update(founderCheckoutCorrelations)
          .set({
            status: "consumed",
            consumedAt: input.recordedAt,
            paymentDetectedAt: eventOccurredAt,
            reconciliationDueAt: new Date(eventOccurredAt.valueOf() + 60 * 60 * 1_000),
            providerSubscriptionId: input.webhook.subscriptionId,
            providerOrderId: input.webhook.orderId,
          })
          .where(eq(founderCheckoutCorrelations.id, locked.id));
      } else if (
        locked.providerSubscriptionId !== input.webhook.subscriptionId ||
        locked.providerOrderId !== input.webhook.orderId
      ) {
        throw new Error("Commerce identity does not match its Checkout Correlation.");
      }
      const [receipt] = await tx
        .insert(founderCommerceEvents)
        .values({
          providerEventId: input.webhook.derivedDeliveryKey,
          userId: locked.userId,
          checkoutCorrelationId: locked.id,
          providerSubscriptionId: input.webhook.subscriptionId,
          providerOrderId: input.webhook.orderId,
          eventType: input.webhook.eventName,
          payloadDigest: input.webhook.payloadDigest,
          signatureVerified: true,
          occurredAt: eventOccurredAt,
          recordedAt: input.recordedAt,
        })
        .returning({ id: founderCommerceEvents.id });
      if (!receipt) throw new Error("Commerce event receipt could not be recorded.");
      return {
        receiptId: receipt.id,
        userId: locked.userId,
        terminal: locked.status === "closed" || locked.status === "refund_pending",
        duplicate: false,
      };
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function reconcileFounderCommerceReceipt(input: {
  receiptId: string;
  now: Date;
  provider: LemonSqueezyCommerceProvider;
  createConnection?: () => DatabaseConnection;
}): Promise<"applied" | "ignored" | "confirming_payment"> {
  const connection = input.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !input.createConnection;
  try {
    const [receipt] = await connection.db
      .select()
      .from(founderCommerceEvents)
      .where(eq(founderCommerceEvents.id, input.receiptId))
      .limit(1);
    if (!receipt) throw new Error("Commerce event receipt was not found.");
    if (receipt.applicationStatus !== "pending") return "ignored";

    let subscription: ReconciledLemonSqueezySubscription;
    let order: ReconciledLemonSqueezyOrder;
    try {
      [subscription, order] = await Promise.all([
        input.provider.readSubscription({ subscriptionId: receipt.providerSubscriptionId }),
        input.provider.readOrder({ orderId: receipt.providerOrderId }),
      ]);
    } catch (error) {
      await retainReceiptFailure(connection, receipt.id, input.now, error);
      return "confirming_payment";
    }
    if (
      subscription.subscriptionId !== receipt.providerSubscriptionId ||
      subscription.orderId !== receipt.providerOrderId ||
      order.orderId !== receipt.providerOrderId
    ) {
      await retainReceiptFailure(connection, receipt.id, input.now, new Error("identity_mismatch"));
      return "confirming_payment";
    }
    const providerStatus = reconciledStatus(subscription, order);

    return await connection.db.transaction(async (tx) => {
      await lockFounderProductContractLifecycleInTransaction(tx, receipt.userId);
      const [lockedReceipt] = await tx
        .select()
        .from(founderCommerceEvents)
        .where(eq(founderCommerceEvents.id, receipt.id))
        .limit(1)
        .for("update");
      const [correlation] = await tx
        .select()
        .from(founderCheckoutCorrelations)
        .where(eq(founderCheckoutCorrelations.id, receipt.checkoutCorrelationId))
        .limit(1)
        .for("update");
      if (!lockedReceipt || !correlation) throw new Error("Commerce authority disappeared.");
      if (lockedReceipt.applicationStatus !== "pending") return "ignored";
      if (correlation.status === "closed" || correlation.status === "refund_pending") {
        await markReceipt(tx, lockedReceipt.id, "ignored", input.now);
        return "ignored";
      }
      if (correlation.reconciliationDueAt && correlation.reconciliationDueAt <= input.now) {
        await tx
          .update(founderCommerceEvents)
          .set({ lastAttemptAt: input.now, lastErrorCode: "payment_reconciliation_timeout" })
          .where(eq(founderCommerceEvents.id, lockedReceipt.id));
        return "confirming_payment";
      }
      if (providerStatus === "active") {
        try {
          await requireFounderGeneralReleasePurchaseDecisionInTransaction(
            tx,
            receipt.userId,
            input.now,
            { allowExistingEntitlement: true },
          );
        } catch {
          await tx
            .update(founderCommerceEvents)
            .set({ lastAttemptAt: input.now, lastErrorCode: "purchase_window_expired" })
            .where(eq(founderCommerceEvents.id, lockedReceipt.id));
          return "confirming_payment";
        }
      }
      const [current] = await tx
        .select()
        .from(founderProductEntitlements)
        .where(eq(founderProductEntitlements.userId, receipt.userId))
        .limit(1)
        .for("update");
      const [currentAuthority] = current
        ? await tx
            .select({
              checkoutCorrelationId: founderCommerceEvents.checkoutCorrelationId,
              generation: founderCheckoutCorrelations.generation,
            })
            .from(founderCommerceEvents)
            .innerJoin(
              founderCheckoutCorrelations,
              eq(founderCheckoutCorrelations.id, founderCommerceEvents.checkoutCorrelationId),
            )
            .where(eq(founderCommerceEvents.id, current.sourceEventId))
            .limit(1)
        : [];
      if (current && !currentAuthority) throw new Error("Current commerce authority disappeared.");
      if (
        currentAuthority &&
        currentAuthority.checkoutCorrelationId !== correlation.id &&
        currentAuthority.generation >= correlation.generation
      ) {
        await markReceipt(tx, lockedReceipt.id, "ignored", input.now);
        return "ignored";
      }
      const providerStateUpdatedAt = new Date(
        Math.max(new Date(subscription.updatedAt).valueOf(), new Date(order.updatedAt).valueOf()),
      );
      if (
        current?.providerSubscriptionId === subscription.subscriptionId &&
        current.providerStateUpdatedAt >= providerStateUpdatedAt
      ) {
        await markReceipt(tx, lockedReceipt.id, "ignored", input.now);
        return "ignored";
      }
      const entitlementStatus = providerStatus === "active" ? "verified" : providerStatus;
      const policy = founderEntitlementPolicy({
        status: providerStatus,
        occurredAt: subscription.updatedAt,
        endsAt: subscription.endsAt,
        currentRetirementDueAt: current?.retirementDueAt ?? null,
      });
      await tx
        .insert(founderProductEntitlements)
        .values({
          userId: receipt.userId,
          sourceEventId: receipt.id,
          providerSubscriptionId: subscription.subscriptionId,
          status: entitlementStatus,
          reconciledProviderStatus: providerStatus,
          providerStateUpdatedAt,
          reconciledAt: input.now,
          retirementDueAt: policy.retirementDueAt,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: founderProductEntitlements.userId,
          set: {
            sourceEventId: receipt.id,
            providerSubscriptionId: subscription.subscriptionId,
            status: entitlementStatus,
            reconciledProviderStatus: providerStatus,
            providerStateUpdatedAt,
            reconciledAt: input.now,
            retirementDueAt: policy.retirementDueAt,
            updatedAt: input.now,
          },
        });
      await applyWorkPause(tx, receipt.userId, policy.stopNewWork, providerStatus, input.now);
      await markReceipt(tx, lockedReceipt.id, "applied", input.now);
      return "applied";
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

async function findCheckoutCorrelation(tx: Transaction, webhook: VerifiedLemonSqueezyWebhook) {
  if (webhook.checkoutCorrelation) {
    return tx
      .select()
      .from(founderCheckoutCorrelations)
      .where(
        eq(
          founderCheckoutCorrelations.correlationDigest,
          founderProductContractDigest(webhook.checkoutCorrelation),
        ),
      )
      .limit(1);
  }
  return tx
    .select()
    .from(founderCheckoutCorrelations)
    .where(
      or(
        eq(founderCheckoutCorrelations.providerSubscriptionId, webhook.subscriptionId),
        eq(founderCheckoutCorrelations.providerOrderId, webhook.orderId),
      ),
    )
    .limit(1);
}

function assertSameReceipt(
  existing: typeof founderCommerceEvents.$inferSelect,
  webhook: VerifiedLemonSqueezyWebhook,
): void {
  if (
    existing.payloadDigest !== webhook.payloadDigest ||
    existing.providerSubscriptionId !== webhook.subscriptionId ||
    existing.providerOrderId !== webhook.orderId ||
    existing.eventType !== webhook.eventName
  ) {
    throw new Error("A derived commerce delivery key was previously recorded differently.");
  }
}

function reconciledStatus(
  subscription: ReconciledLemonSqueezySubscription,
  order: ReconciledLemonSqueezyOrder,
): LemonSqueezyCommerceStatus {
  if (order.status === "refunded" && order.refundedAmount >= order.total) return "refunded";
  if (
    order.status === "partial_refund" ||
    order.status === "fraudulent" ||
    order.status === "failed"
  ) {
    return "unpaid";
  }
  if (order.status !== "paid") return "unpaid";
  return subscription.status;
}

async function markReceipt(
  tx: Transaction,
  receiptId: string,
  status: "applied" | "ignored",
  now: Date,
): Promise<void> {
  await tx
    .update(founderCommerceEvents)
    .set({ applicationStatus: status, lastAttemptAt: now, appliedAt: now, lastErrorCode: null })
    .where(eq(founderCommerceEvents.id, receiptId));
}

async function retainReceiptFailure(
  connection: DatabaseConnection,
  receiptId: string,
  now: Date,
  error: unknown,
): Promise<void> {
  await connection.db
    .update(founderCommerceEvents)
    .set({
      lastAttemptAt: now,
      lastErrorCode:
        error instanceof Error && error.message === "identity_mismatch"
          ? "provider_identity_mismatch"
          : "provider_reconciliation_unavailable",
    })
    .where(
      and(
        eq(founderCommerceEvents.id, receiptId),
        eq(founderCommerceEvents.applicationStatus, "pending"),
      ),
    );
}

async function applyWorkPause(
  tx: Transaction,
  userId: string,
  stopNewWork: boolean,
  status: LemonSqueezyCommerceStatus,
  now: Date,
): Promise<void> {
  if (stopNewWork) {
    await tx
      .update(operators)
      .set({
        externalActionPause: true,
        externalActionPauseReason: ENTITLEMENT_PAUSE_REASON,
        externalActionPausedAt: now,
        updatedAt: now,
      })
      .where(eq(operators.userId, userId));
  } else if (status === "active") {
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
          eq(operators.userId, userId),
          eq(operators.externalActionPauseReason, ENTITLEMENT_PAUSE_REASON),
        ),
      );
  }
}
