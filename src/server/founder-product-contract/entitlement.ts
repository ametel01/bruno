import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, gt, inArray, lte, or } from "drizzle-orm";
import type { DatabaseConnection } from "@/src/server/db/client";
import {
  founderCommerceEvents,
  founderCheckoutCorrelations,
  founderProductEntitlements,
  operators,
} from "@/src/server/db/schema";
import type {
  FounderCommerceEvent,
  FounderCommerceStatus,
  FounderLifecycleProviderBoundary,
} from "./lifecycle";
import { founderProductContractDigest } from "./digest";

type Transaction = Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0];

const ENTITLEMENT_PAUSE_REASON = "Product Entitlement does not authorize new work.";

export async function reconcileFounderCommerceEvent(
  tx: Transaction,
  input: { userId: string; now: Date; commerceEvent?: FounderCommerceEvent },
  dependencies: {
    providers: Pick<FounderLifecycleProviderBoundary, "readSubscription">;
    commerceWebhookSecret: string;
  },
): Promise<void> {
  if (!input.commerceEvent) throw new Error("A signed commerce event is required.");
  const event = input.commerceEvent;
  const canonicalPayload = canonicalCommercePayload(event);
  if (!verifyHmac(canonicalPayload, event.signature, dependencies.commerceWebhookSecret)) {
    throw new Error("The Lemon Squeezy event signature is invalid.");
  }
  const payloadDigest = founderProductContractDigest(canonicalPayload);
  const [existingReceipt] = await tx
    .select()
    .from(founderCommerceEvents)
    .where(eq(founderCommerceEvents.providerEventId, event.eventId))
    .limit(1);
  const [currentEntitlement] = await tx
    .select({
      sourceEventId: founderProductEntitlements.sourceEventId,
      providerSubscriptionId: founderProductEntitlements.providerSubscriptionId,
      retirementDueAt: founderProductEntitlements.retirementDueAt,
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
  const eventOccurredAt = exactInstant(event.occurredAt, "event timestamp");
  if (
    currentSource &&
    ((existingReceipt && existingReceipt.id !== currentSource.id) ||
      (!existingReceipt && eventOccurredAt <= currentSource.occurredAt))
  ) {
    throw new Error("A delayed or reordered commerce event cannot replace newer authority.");
  }
  let receipt = existingReceipt;
  if (!receipt) {
    const correlationId = await consumeOrVerifyCheckoutCorrelation(
      tx,
      input,
      event,
      currentEntitlement,
      currentSource,
    );
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
  const policy = founderEntitlementPolicy({
    status: event.status,
    occurredAt: event.occurredAt,
    endsAt: event.endsAt,
    currentRetirementDueAt: currentEntitlement?.retirementDueAt ?? null,
  });
  await tx
    .insert(founderProductEntitlements)
    .values({
      userId: input.userId,
      sourceEventId: receipt.id,
      providerSubscriptionId: event.subscriptionId,
      status,
      reconciledProviderStatus: subscription.status,
      reconciledAt: input.now,
      retirementDueAt: policy.retirementDueAt,
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
        retirementDueAt: policy.retirementDueAt,
        updatedAt: input.now,
      },
    });
  if (policy.stopNewWork) {
    await tx
      .update(operators)
      .set({
        externalActionPause: true,
        externalActionPauseReason: ENTITLEMENT_PAUSE_REASON,
        externalActionPausedAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(operators.userId, input.userId));
  } else if (event.status === "active") {
    await tx
      .update(operators)
      .set({
        externalActionPause: false,
        externalActionPauseReason: null,
        externalActionPausedAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(operators.userId, input.userId),
          eq(operators.externalActionPauseReason, ENTITLEMENT_PAUSE_REASON),
        ),
      );
  }
}

export function founderEntitlementPolicy(input: {
  status: FounderCommerceStatus;
  occurredAt: string;
  endsAt: string | null;
  currentRetirementDueAt: Date | null;
}): { retirementDueAt: Date | null; stopNewWork: boolean } {
  const occurredAt = exactInstant(input.occurredAt, "event timestamp");
  let proposedDueAt: Date | null;
  let stopNewWork = false;
  switch (input.status) {
    case "active":
      proposedDueAt = null;
      break;
    case "past_due":
      proposedDueAt = new Date(occurredAt.valueOf() + 7 * 24 * 60 * 60 * 1_000);
      break;
    case "unpaid":
    case "refunded":
      proposedDueAt = new Date(occurredAt.valueOf() + 24 * 60 * 60 * 1_000);
      stopNewWork = true;
      break;
    case "expired":
      proposedDueAt = new Date(occurredAt.valueOf() + 60 * 60 * 1_000);
      stopNewWork = true;
      break;
    case "cancelled":
      if (!input.endsAt) throw new Error("Cancelled entitlement requires its paid ends_at.");
      proposedDueAt = exactInstant(input.endsAt, "paid ends_at");
      break;
  }
  if (input.status !== "active" && input.currentRetirementDueAt && proposedDueAt) {
    proposedDueAt = new Date(
      Math.min(input.currentRetirementDueAt.valueOf(), proposedDueAt.valueOf()),
    );
  }
  return { retirementDueAt: proposedDueAt, stopNewWork };
}

export async function requireOperationalEntitlement(
  tx: Transaction,
  userId: string,
  now: Date,
): Promise<void> {
  const [entitlement] = await tx
    .select({ id: founderProductEntitlements.id })
    .from(founderProductEntitlements)
    .where(
      and(
        eq(founderProductEntitlements.userId, userId),
        or(
          eq(founderProductEntitlements.status, "verified"),
          and(
            inArray(founderProductEntitlements.status, ["past_due", "cancelled"]),
            gt(founderProductEntitlements.retirementDueAt, now),
          ),
        ),
      ),
    )
    .limit(1);
  if (!entitlement) throw new Error("Operational Product Entitlement is required.");
}

export async function requireRetirementDue(
  tx: Transaction,
  userId: string,
  now: Date,
): Promise<void> {
  const [entitlement] = await tx
    .select({ id: founderProductEntitlements.id })
    .from(founderProductEntitlements)
    .where(
      and(
        eq(founderProductEntitlements.userId, userId),
        inArray(founderProductEntitlements.status, [
          "past_due",
          "unpaid",
          "cancelled",
          "expired",
          "refunded",
        ]),
        lte(founderProductEntitlements.retirementDueAt, now),
      ),
    )
    .limit(1);
  if (!entitlement) throw new Error("Product Entitlement retirement is not due.");
}

async function consumeOrVerifyCheckoutCorrelation(
  tx: Transaction,
  input: { userId: string; now: Date },
  event: FounderCommerceEvent,
  currentEntitlement:
    | { sourceEventId: string; providerSubscriptionId: string; retirementDueAt: Date | null }
    | undefined,
  currentSource: { id: string; checkoutCorrelationId: string; occurredAt: Date } | undefined,
): Promise<string> {
  if (event.status === "active") {
    const [correlation] = await tx
      .select({ id: founderCheckoutCorrelations.id })
      .from(founderCheckoutCorrelations)
      .where(
        and(
          eq(founderCheckoutCorrelations.userId, input.userId),
          eq(
            founderCheckoutCorrelations.correlationDigest,
            founderProductContractDigest(event.checkoutCorrelation),
          ),
          eq(founderCheckoutCorrelations.status, "pending"),
          gt(founderCheckoutCorrelations.expiresAt, input.now),
        ),
      )
      .limit(1)
      .for("update");
    if (!correlation) throw new Error("A pending Owner-bound Checkout Correlation is required.");
    await tx
      .update(founderCheckoutCorrelations)
      .set({ status: "consumed", consumedAt: input.now })
      .where(eq(founderCheckoutCorrelations.id, correlation.id));
    return correlation.id;
  }
  if (!currentEntitlement || currentEntitlement.providerSubscriptionId !== event.subscriptionId) {
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
              founderProductContractDigest(event.checkoutCorrelation),
            ),
          ),
        )
        .limit(1)
    : [];
  if (!correlation) throw new Error("The commerce event Checkout Correlation is invalid.");
  return correlation.id;
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

function exactInstant(value: string, label: string): Date {
  const instant = new Date(value);
  if (Number.isNaN(instant.valueOf()) || instant.toISOString() !== value) {
    throw new Error(`The Lemon Squeezy ${label} is invalid.`);
  }
  return instant;
}
