import "server-only";

import { randomBytes } from "node:crypto";
import { and, desc, eq, or } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderCheckoutCorrelations,
  founderCommerceEvents,
  founderCommerceLifecycleReceipts,
  founderInfrastructureRetirements,
  founderOperatorRestorations,
  founderProductEntitlements,
  operatorDeletionCommerceCancellations,
  operators,
} from "@/src/server/db/schema";
import { founderProductContractDigest } from "@/src/server/founder-product-contract/digest";
import {
  founderCommerceTransitionAllows,
  founderEntitlementPolicy,
} from "@/src/server/founder-product-contract/entitlement";
import {
  FounderGeneralReleaseError,
  requireFounderGeneralReleasePurchaseDecisionInTransaction,
} from "@/src/server/founder-product-contract/initial-general-release";
import {
  lockFounderProductContractLifecycleInTransaction,
  requireActiveFounderOperatorAuthorityInTransaction,
} from "@/src/server/founder-product-contract/operator-authority";
import {
  FOUNDER_COMMERCE_WEBHOOK_INTAKE_PENDING_CODE,
  getFounderAccountClosureCommerceFenceInTransaction,
  isFounderAccountClosureSubscriptionInTransaction,
  lockFounderCommerceWebhookIntakeInTransaction,
} from "./founder-account-closure-fence";
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
      status: "verified";
      customerPortalAvailable: true;
    }
  | { state: "payment_recovery"; recoveryEndsAt: string; customerPortalAvailable: true }
  | { state: "cancelled_through"; endsAt: string; customerPortalAvailable: true }
  | {
      state: "payment_refunded";
      refundConfirmedAt: string;
      cleanup: "required" | "in_progress" | "completed";
    }
  | {
      state: "work_stopped";
      reason: "unpaid" | "expired" | "refunded" | "cancelled" | "past_due";
      retirementDueAt: string;
      retirement: "required" | "in_progress";
    }
  | {
      state: "retirement_completed";
      reason: "unpaid" | "expired" | "refunded" | "cancelled" | "past_due";
      completedAt: string;
    }
  | {
      state: "restoring";
      environment: "same Operator, new infrastructure";
      providerAccess: "reauthorization required";
      work: "paused";
    }
  | {
      state: "provider_reauthorization_required";
      environment: "same Operator, new infrastructure";
      providerAccess: "reauthorization required";
      work: "paused";
    }
  | {
      state: "new_operator_environment";
      payment: "refunded";
      providerAccess: "not carried forward";
      work: "paused";
    };

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
      if (await getFounderAccountClosureCommerceFenceInTransaction(tx, input.userId)) {
        throw new Error("Account Closure permanently fences new commerce.");
      }
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
  dependencies: { createConnection?: () => DatabaseConnection; now?: Date } = {},
): Promise<FounderCommerceStatusDto> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const [[attempt], [entitlement], [retirement], [entitlementAuthority], [restoration]] =
      await Promise.all([
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
          .select({
            status: founderInfrastructureRetirements.status,
            absenceVerifiedAt: founderInfrastructureRetirements.absenceVerifiedAt,
          })
          .from(founderInfrastructureRetirements)
          .where(eq(founderInfrastructureRetirements.userId, userId))
          .orderBy(desc(founderInfrastructureRetirements.updatedAt))
          .limit(1),
        connection.db
          .select({ generation: founderCheckoutCorrelations.generation })
          .from(founderProductEntitlements)
          .innerJoin(
            founderCommerceEvents,
            eq(founderCommerceEvents.id, founderProductEntitlements.sourceEventId),
          )
          .innerJoin(
            founderCheckoutCorrelations,
            eq(founderCheckoutCorrelations.id, founderCommerceEvents.checkoutCorrelationId),
          )
          .where(eq(founderProductEntitlements.userId, userId))
          .limit(1),
        connection.db
          .select()
          .from(founderOperatorRestorations)
          .where(eq(founderOperatorRestorations.userId, userId))
          .orderBy(desc(founderOperatorRestorations.createdAt))
          .limit(1),
      ]);
    if (
      restoration?.mode === "same_logical_operator" &&
      (restoration.status === "in_progress" ||
        restoration.status === "provider_reauthorization_required")
    ) {
      return {
        state:
          restoration.status === "provider_reauthorization_required"
            ? "provider_reauthorization_required"
            : "restoring",
        environment: "same Operator, new infrastructure",
        providerAccess: "reauthorization required",
        work: "paused",
      };
    }
    if (restoration?.mode === "new_operator_environment" && restoration.status === "refunded") {
      return {
        state: "new_operator_environment",
        payment: "refunded",
        providerAccess: "not carried forward",
        work: "paused",
      };
    }
    if (
      (attempt?.status === "pending" ||
        attempt?.status === "consumed" ||
        attempt?.status === "refund_pending") &&
      (!entitlementAuthority || attempt.generation > entitlementAuthority.generation)
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
    if (entitlement.status === "verified") {
      return {
        state: "entitled",
        status: "verified",
        customerPortalAvailable: true,
      };
    }
    if (!entitlement.retirementDueAt) {
      throw new Error("Commerce lifecycle deadline is unavailable.");
    }
    const now = dependencies.now ?? new Date();
    if (entitlement.retirementDueAt > now && entitlement.status === "past_due") {
      return {
        state: "payment_recovery",
        recoveryEndsAt: entitlement.retirementDueAt.toISOString(),
        customerPortalAvailable: true,
      };
    }
    if (entitlement.retirementDueAt > now && entitlement.status === "cancelled") {
      return {
        state: "cancelled_through",
        endsAt: entitlement.retirementDueAt.toISOString(),
        customerPortalAvailable: true,
      };
    }
    if (retirement?.status === "completed" && retirement.absenceVerifiedAt) {
      return {
        state: "retirement_completed",
        reason: entitlement.status,
        completedAt: retirement.absenceVerifiedAt.toISOString(),
      };
    }
    return {
      state: "work_stopped",
      reason: entitlement.status,
      retirementDueAt: entitlement.retirementDueAt.toISOString(),
      retirement: retirement ? "in_progress" : "required",
    };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function issueFounderCustomerPortal(input: {
  userId: string;
  now: Date;
  provider: LemonSqueezyCommerceProvider;
  createConnection?: () => DatabaseConnection;
}): Promise<{ portalUrl: string }> {
  const connection = input.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !input.createConnection;
  try {
    const subscriptionId = await connection.db.transaction(async (tx) => {
      await lockFounderProductContractLifecycleInTransaction(tx, input.userId);
      return requirePortalEligibleSubscription(tx, input.userId, input.now);
    });
    const portal = await input.provider.createCustomerPortal({
      subscriptionId,
      now: input.now,
    });
    await connection.db.transaction(async (tx) => {
      await lockFounderProductContractLifecycleInTransaction(tx, input.userId);
      const currentSubscriptionId = await requirePortalEligibleSubscription(
        tx,
        input.userId,
        input.now,
      );
      if (currentSubscriptionId !== subscriptionId) {
        throw new Error("Customer Portal authority changed while the link was issued.");
      }
      await tx.insert(founderCommerceLifecycleReceipts).values({
        userId: input.userId,
        providerSubscriptionId: subscriptionId,
        kind: "portal_issued",
        portalExpiresAt: new Date(portal.expiresAt),
        evidenceDigest: founderProductContractDigest(portal.portalUrl),
        occurredAt: input.now,
        createdAt: input.now,
      });
    });
    return { portalUrl: portal.portalUrl };
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
    const intake = await connection.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(founderCommerceEvents)
        .where(eq(founderCommerceEvents.providerEventId, input.webhook.derivedDeliveryKey))
        .limit(1);
      if (existing) {
        assertSameReceipt(existing, input.webhook);
        return {
          receipt: existing,
          userId: existing.userId,
          duplicate: true,
        };
      }

      const [correlation] = await findCheckoutCorrelation(tx, input.webhook);
      if (!correlation) throw new Error("Checkout Correlation was not found.");
      await lockFounderCommerceWebhookIntakeInTransaction(tx, correlation.userId, "intake");
      const eventOccurredAt = new Date(input.webhook.occurredAt);
      const [createdReceipt] = await tx
        .insert(founderCommerceEvents)
        .values({
          providerEventId: input.webhook.derivedDeliveryKey,
          userId: correlation.userId,
          checkoutCorrelationId: correlation.id,
          providerSubscriptionId: input.webhook.subscriptionId,
          providerOrderId: input.webhook.orderId,
          eventType: input.webhook.eventName,
          payloadDigest: input.webhook.payloadDigest,
          signatureVerified: true,
          occurredAt: eventOccurredAt,
          recordedAt: input.recordedAt,
          lastErrorCode: FOUNDER_COMMERCE_WEBHOOK_INTAKE_PENDING_CODE,
        })
        .onConflictDoNothing({ target: founderCommerceEvents.providerEventId })
        .returning();
      if (createdReceipt) {
        return { receipt: createdReceipt, userId: correlation.userId, duplicate: false };
      }
      const [conflictingReceipt] = await tx
        .select()
        .from(founderCommerceEvents)
        .where(eq(founderCommerceEvents.providerEventId, input.webhook.derivedDeliveryKey))
        .limit(1);
      if (!conflictingReceipt) throw new Error("Commerce event intake could not be recorded.");
      assertSameReceipt(conflictingReceipt, input.webhook);
      return { receipt: conflictingReceipt, userId: conflictingReceipt.userId, duplicate: true };
    });
    if (intake.receipt.lastErrorCode !== FOUNDER_COMMERCE_WEBHOOK_INTAKE_PENDING_CODE) {
      const [correlation] = await connection.db
        .select({ status: founderCheckoutCorrelations.status })
        .from(founderCheckoutCorrelations)
        .where(eq(founderCheckoutCorrelations.id, intake.receipt.checkoutCorrelationId))
        .limit(1);
      return {
        receiptId: intake.receipt.id,
        userId: intake.userId,
        terminal: correlation?.status === "closed" || correlation?.status === "refund_pending",
        duplicate: true,
      };
    }

    return await connection.db.transaction(async (tx) => {
      await lockFounderProductContractLifecycleInTransaction(tx, intake.userId);
      const [lockedReceipt] = await tx
        .select()
        .from(founderCommerceEvents)
        .where(eq(founderCommerceEvents.id, intake.receipt.id))
        .limit(1)
        .for("update");
      if (!lockedReceipt) throw new Error("Commerce event intake disappeared.");
      assertSameReceipt(lockedReceipt, input.webhook);
      const [locked] = await tx
        .select()
        .from(founderCheckoutCorrelations)
        .where(eq(founderCheckoutCorrelations.id, lockedReceipt.checkoutCorrelationId))
        .limit(1)
        .for("update");
      if (!locked) throw new Error("Checkout Correlation was not found.");
      if (lockedReceipt.lastErrorCode !== FOUNDER_COMMERCE_WEBHOOK_INTAKE_PENDING_CODE) {
        return {
          receiptId: lockedReceipt.id,
          userId: lockedReceipt.userId,
          terminal: locked.status === "closed" || locked.status === "refund_pending",
          duplicate: true,
        };
      }
      const closureFence = await getFounderAccountClosureCommerceFenceInTransaction(
        tx,
        locked.userId,
      );
      const eventOccurredAt = new Date(input.webhook.occurredAt);
      const closureSubscriptionKnown = closureFence
        ? await isFounderAccountClosureSubscriptionInTransaction(
            tx,
            closureFence.requestId,
            input.webhook.subscriptionId,
          )
        : false;
      if (closureFence && !closureSubscriptionKnown) {
        if (
          locked.status !== "pending" &&
          locked.status !== "consumed" &&
          locked.status !== "refund_pending" &&
          !(locked.status === "closed" && locked.closureReason === "account_closure")
        ) {
          throw new Error("Account Closure rejects unrelated commerce evidence.");
        }
        if (locked.status === "pending" || locked.status === "closed") {
          await tx
            .update(founderCheckoutCorrelations)
            .set({
              status: "closed",
              providerSubscriptionId: input.webhook.subscriptionId,
              providerOrderId: input.webhook.orderId,
              consumedAt: input.recordedAt,
              paymentDetectedAt: eventOccurredAt,
              reconciliationDueAt: new Date(eventOccurredAt.valueOf() + 60 * 60 * 1_000),
              closedAt: locked.closedAt ?? input.recordedAt,
              closureReason: "account_closure",
            })
            .where(eq(founderCheckoutCorrelations.id, locked.id));
        }
        await tx
          .insert(operatorDeletionCommerceCancellations)
          .values({
            requestId: closureFence.requestId,
            operatorId: closureFence.operatorId,
            provider: "lemon_squeezy",
            providerSubscriptionId: input.webhook.subscriptionId,
            createdAt: input.recordedAt,
            updatedAt: input.recordedAt,
          })
          .onConflictDoNothing({
            target: [
              operatorDeletionCommerceCancellations.requestId,
              operatorDeletionCommerceCancellations.providerSubscriptionId,
            ],
          });
        await tx
          .update(founderCommerceEvents)
          .set({
            applicationStatus: "ignored",
            lastAttemptAt: input.recordedAt,
            appliedAt: input.recordedAt,
            lastErrorCode: null,
          })
          .where(eq(founderCommerceEvents.id, lockedReceipt.id));
        return {
          receiptId: lockedReceipt.id,
          userId: locked.userId,
          terminal: true,
          duplicate: intake.duplicate,
        };
      }
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
      await tx
        .update(founderCommerceEvents)
        .set({ lastErrorCode: null })
        .where(eq(founderCommerceEvents.id, lockedReceipt.id));
      return {
        receiptId: lockedReceipt.id,
        userId: locked.userId,
        terminal: locked.status === "closed" || locked.status === "refund_pending",
        duplicate: intake.duplicate,
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
}): Promise<"applied" | "ignored" | "confirming_payment" | "restoration_required"> {
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
    if (receipt.lastErrorCode === FOUNDER_COMMERCE_WEBHOOK_INTAKE_PENDING_CODE) {
      return "confirming_payment";
    }

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
      const closureFence = await getFounderAccountClosureCommerceFenceInTransaction(
        tx,
        receipt.userId,
      );
      const closureSubscriptionKnown = closureFence
        ? await isFounderAccountClosureSubscriptionInTransaction(
            tx,
            closureFence.requestId,
            receipt.providerSubscriptionId,
          )
        : false;
      const closureCancellation = Boolean(
        closureFence && closureSubscriptionKnown && subscription.status === "cancelled",
      );
      if (closureFence && !closureCancellation) {
        await markReceipt(tx, lockedReceipt.id, "ignored", input.now);
        return "ignored";
      }
      if (
        !closureCancellation &&
        (correlation.status === "refund_pending" ||
          (correlation.status === "closed" && correlation.closureReason !== "account_closure"))
      ) {
        await markReceipt(tx, lockedReceipt.id, "ignored", input.now);
        return "ignored";
      }
      if (providerStatus === "active") {
        try {
          await requireFounderGeneralReleasePurchaseDecisionInTransaction(
            tx,
            receipt.userId,
            input.now,
            { allowExistingEntitlement: true },
          );
        } catch (error) {
          if (
            !(error instanceof FounderGeneralReleaseError) ||
            error.code !== "purchase_decision_unavailable"
          ) {
            throw error;
          }
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
        !closureCancellation &&
        currentAuthority &&
        currentAuthority.checkoutCorrelationId !== correlation.id &&
        currentAuthority.generation >= correlation.generation
      ) {
        await markReceipt(tx, lockedReceipt.id, "ignored", input.now);
        return "ignored";
      }
      if (
        !closureFence &&
        correlation.reconciliationDueAt &&
        correlation.reconciliationDueAt <= input.now &&
        currentAuthority?.checkoutCorrelationId !== correlation.id
      ) {
        await tx
          .update(founderCommerceEvents)
          .set({ lastAttemptAt: input.now, lastErrorCode: "payment_reconciliation_timeout" })
          .where(eq(founderCommerceEvents.id, lockedReceipt.id));
        return "confirming_payment";
      }
      if (providerStatus === "active") {
        const [completedRetirement] = await tx
          .select({
            id: founderInfrastructureRetirements.id,
            absenceVerifiedAt: founderInfrastructureRetirements.absenceVerifiedAt,
          })
          .from(founderInfrastructureRetirements)
          .where(
            and(
              eq(founderInfrastructureRetirements.userId, receipt.userId),
              eq(founderInfrastructureRetirements.status, "completed"),
            ),
          )
          .orderBy(desc(founderInfrastructureRetirements.absenceVerifiedAt))
          .limit(1);
        if (completedRetirement?.absenceVerifiedAt) {
          await tx
            .update(founderCommerceEvents)
            .set({
              lastAttemptAt: input.now,
              lastErrorCode: "returning_founder_restoration_required",
            })
            .where(eq(founderCommerceEvents.id, lockedReceipt.id));
          return "restoration_required";
        }
      }
      if (
        providerStatus === "active" &&
        currentAuthority?.checkoutCorrelationId === correlation.id &&
        current &&
        !founderCommerceTransitionAllows({
          incomingStatus: providerStatus,
          currentStatus: current.reconciledProviderStatus as LemonSqueezyCommerceStatus,
          currentRetirementDueAt: current.retirementDueAt,
          now: input.now,
          retirementStarted: false,
        })
      ) {
        await markReceipt(tx, lockedReceipt.id, "ignored", input.now);
        return "ignored";
      }
      if (
        providerStatus === "active" &&
        currentAuthority?.checkoutCorrelationId === correlation.id
      ) {
        const [retirement] = await tx
          .select({ id: founderInfrastructureRetirements.id })
          .from(founderInfrastructureRetirements)
          .where(eq(founderInfrastructureRetirements.userId, receipt.userId))
          .limit(1);
        if (retirement) {
          await markReceipt(tx, lockedReceipt.id, "ignored", input.now);
          return "ignored";
        }
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
        occurredAt: providerStateUpdatedAt.toISOString(),
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
      await recordFounderCommerceLifecycleDecisionReceiptInTransaction(tx, {
        userId: receipt.userId,
        sourceEventId: receipt.id,
        providerSubscriptionId: subscription.subscriptionId,
        providerStatus,
        effectiveAt:
          providerStatus === "cancelled" && subscription.endsAt
            ? new Date(subscription.endsAt)
            : providerStateUpdatedAt,
        occurredAt: providerStateUpdatedAt,
        createdAt: input.now,
      });
      if (providerStatus !== "cancelled" && subscription.status === "cancelled") {
        await recordFounderCommerceLifecycleDecisionReceiptInTransaction(tx, {
          userId: receipt.userId,
          sourceEventId: receipt.id,
          providerSubscriptionId: subscription.subscriptionId,
          providerStatus: "cancelled",
          effectiveAt: subscription.endsAt ? new Date(subscription.endsAt) : providerStateUpdatedAt,
          occurredAt: providerStateUpdatedAt,
          createdAt: input.now,
        });
      }
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

async function requirePortalEligibleSubscription(
  tx: Transaction,
  userId: string,
  now: Date,
): Promise<string> {
  const [[entitlement], [retirement]] = await Promise.all([
    tx
      .select({
        providerSubscriptionId: founderProductEntitlements.providerSubscriptionId,
        status: founderProductEntitlements.status,
        retirementDueAt: founderProductEntitlements.retirementDueAt,
      })
      .from(founderProductEntitlements)
      .where(eq(founderProductEntitlements.userId, userId))
      .limit(1),
    tx
      .select({ id: founderInfrastructureRetirements.id })
      .from(founderInfrastructureRetirements)
      .where(eq(founderInfrastructureRetirements.userId, userId))
      .limit(1),
  ]);
  if (retirement) throw new Error("Customer Portal is unavailable after retirement begins.");
  if (!entitlement) throw new Error("Customer Portal requires a Product Entitlement.");
  if (entitlement.status === "verified") return entitlement.providerSubscriptionId;
  if (
    (entitlement.status === "past_due" || entitlement.status === "cancelled") &&
    entitlement.retirementDueAt &&
    entitlement.retirementDueAt > now
  ) {
    return entitlement.providerSubscriptionId;
  }
  throw new Error("Customer Portal is unavailable for this commerce state.");
}

export async function recordFounderCommerceLifecycleDecisionReceiptInTransaction(
  tx: Transaction,
  input: {
    userId: string;
    sourceEventId: string;
    providerSubscriptionId: string;
    providerStatus: LemonSqueezyCommerceStatus;
    effectiveAt: Date;
    occurredAt: Date;
    createdAt: Date;
    orderId?: string;
  },
): Promise<void> {
  const kind =
    input.providerStatus === "cancelled"
      ? "cancellation"
      : input.providerStatus === "refunded"
        ? "refund"
        : null;
  if (!kind) return;
  await tx
    .insert(founderCommerceLifecycleReceipts)
    .values({
      userId: input.userId,
      sourceEventId: input.sourceEventId,
      providerSubscriptionId: input.providerSubscriptionId,
      kind,
      effectiveAt: input.effectiveAt,
      evidenceDigest: founderProductContractDigest(
        JSON.stringify({
          kind,
          providerSubscriptionId: input.providerSubscriptionId,
          orderId: input.orderId ?? null,
          effectiveAt: input.effectiveAt.toISOString(),
          occurredAt: input.occurredAt.toISOString(),
        }),
      ),
      occurredAt: input.occurredAt,
      createdAt: input.createdAt,
    })
    .onConflictDoNothing({
      target: [
        founderCommerceLifecycleReceipts.sourceEventId,
        founderCommerceLifecycleReceipts.kind,
      ],
    });
}
