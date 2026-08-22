import { createHash } from "node:crypto";
import type { DatabaseConnection } from "@/src/server/db/client";
import {
  founderCheckoutCorrelations,
  founderCommerceEvents,
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
  const [correlation] = await connection.db
    .insert(founderCheckoutCorrelations)
    .values({
      userId,
      correlationDigest: digest(`${fixtureId}:correlation`),
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
      providerOrderId: `order-${providerSubscriptionId}`,
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

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
