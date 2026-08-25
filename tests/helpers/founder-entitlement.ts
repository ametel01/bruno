import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DatabaseConnection } from "@/src/server/db/client";
import {
  founderCheckoutCorrelations,
  founderCommerceEvents,
  founderCommerceLifecycleReceipts,
  founderProductEntitlements,
} from "@/src/server/db/schema";

type PastDueFounderEntitlementFixture = {
  connection: DatabaseConnection;
  userId: string;
  fixtureId: string;
  reconciledAt: Date;
  retirementDueAt: Date;
};

export async function insertPastDueFounderEntitlementFixture({
  connection,
  userId,
  fixtureId,
  reconciledAt,
  retirementDueAt,
}: PastDueFounderEntitlementFixture): Promise<void> {
  const providerSubscriptionId = `subscription-${fixtureId}`;
  const providerOrderId = `order-${providerSubscriptionId}`;
  const [correlation] = await connection.db
    .insert(founderCheckoutCorrelations)
    .values({
      userId,
      correlationDigest: digest(`${fixtureId}:correlation`),
      status: "consumed",
      providerSubscriptionId,
      providerOrderId,
      consumedAt: reconciledAt,
      paymentDetectedAt: reconciledAt,
      reconciliationDueAt: new Date(reconciledAt.valueOf() + 60 * 60 * 1_000),
      createdAt: reconciledAt,
      expiresAt: new Date(
        Math.max(reconciledAt.getTime(), retirementDueAt.getTime()) + 24 * 60 * 60 * 1_000,
      ),
    })
    .returning({ id: founderCheckoutCorrelations.id });
  if (!correlation) throw new Error("entitlement correlation setup failed");

  const [event] = await connection.db
    .insert(founderCommerceEvents)
    .values({
      providerEventId: `${fixtureId}:past-due-event`,
      userId,
      checkoutCorrelationId: correlation.id,
      providerSubscriptionId,
      providerOrderId,
      eventType: "subscription.past_due",
      payloadDigest: digest(`${fixtureId}:payload`),
      signatureVerified: true,
      occurredAt: reconciledAt,
      recordedAt: reconciledAt,
    })
    .returning({ id: founderCommerceEvents.id });
  if (!event) throw new Error("entitlement event setup failed");

  await connection.db.insert(founderProductEntitlements).values({
    userId,
    sourceEventId: event.id,
    providerSubscriptionId,
    status: "past_due",
    reconciledProviderStatus: "past_due",
    providerStateUpdatedAt: reconciledAt,
    reconciledAt,
    retirementDueAt,
    updatedAt: reconciledAt,
  });
}

export async function insertReconciledFounderCancellationFixture(input: {
  connection: DatabaseConnection;
  userId: string;
  fixtureId: string;
  providerUpdatedAt: Date;
  effectiveAt: Date;
}): Promise<{ eventId: string; lifecycleReceiptId: string }> {
  const [entitlement] = await input.connection.db
    .select()
    .from(founderProductEntitlements)
    .where(eq(founderProductEntitlements.userId, input.userId))
    .limit(1);
  if (!entitlement) throw new Error("entitlement setup missing");
  const [source] = await input.connection.db
    .select()
    .from(founderCommerceEvents)
    .where(eq(founderCommerceEvents.id, entitlement.sourceEventId))
    .limit(1);
  if (!source) throw new Error("entitlement source setup missing");
  const [event] = await input.connection.db
    .insert(founderCommerceEvents)
    .values({
      providerEventId: `${input.fixtureId}:cancellation-event`,
      userId: input.userId,
      checkoutCorrelationId: source.checkoutCorrelationId,
      providerSubscriptionId: entitlement.providerSubscriptionId,
      providerOrderId: source.providerOrderId,
      eventType: "subscription_updated",
      payloadDigest: digest(`${input.fixtureId}:cancellation-payload`),
      signatureVerified: true,
      occurredAt: input.providerUpdatedAt,
      recordedAt: input.providerUpdatedAt,
      applicationStatus: "applied",
      appliedAt: input.providerUpdatedAt,
    })
    .returning({ id: founderCommerceEvents.id });
  if (!event) throw new Error("cancellation event setup failed");
  await input.connection.db
    .update(founderProductEntitlements)
    .set({
      sourceEventId: event.id,
      status: "cancelled",
      reconciledProviderStatus: "cancelled",
      providerStateUpdatedAt: input.providerUpdatedAt,
      reconciledAt: input.providerUpdatedAt,
      retirementDueAt: input.effectiveAt,
      updatedAt: input.providerUpdatedAt,
    })
    .where(eq(founderProductEntitlements.userId, input.userId));
  const [receipt] = await input.connection.db
    .insert(founderCommerceLifecycleReceipts)
    .values({
      userId: input.userId,
      sourceEventId: event.id,
      providerSubscriptionId: entitlement.providerSubscriptionId,
      kind: "cancellation",
      effectiveAt: input.effectiveAt,
      evidenceDigest: digest(`${input.fixtureId}:cancellation-receipt`),
      occurredAt: input.providerUpdatedAt,
      createdAt: input.providerUpdatedAt,
    })
    .returning({ id: founderCommerceLifecycleReceipts.id });
  if (!receipt) throw new Error("cancellation receipt setup failed");
  return { eventId: event.id, lifecycleReceiptId: receipt.id };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
