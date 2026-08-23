import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, gt, inArray, lte } from "drizzle-orm";
import type { DatabaseConnection } from "@/src/server/db/client";
import {
  founderCheckoutCorrelations,
  founderCommerceEvents,
  founderExternalBetaInvitations,
  founderInfrastructureRetirements,
  founderProductEntitlements,
  operators,
} from "@/src/server/db/schema";
import { founderProductContractDigest } from "./digest";
import type {
  FounderCommerceEvent,
  FounderCommerceStatus,
  FounderLifecycleProviderBoundary,
} from "./lifecycle";

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
      reconciledProviderStatus: founderProductEntitlements.reconciledProviderStatus,
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
        providerOrderId: `order-${event.subscriptionId}`,
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
  if (
    event.status === "active" &&
    currentEntitlement &&
    !founderCommerceTransitionAllows({
      incomingStatus: event.status,
      currentStatus: currentEntitlement.reconciledProviderStatus as FounderCommerceStatus,
      currentRetirementDueAt: currentEntitlement.retirementDueAt,
      now: input.now,
      retirementStarted: false,
    })
  ) {
    throw new Error("A commerce event cannot restart an expired retirement clock.");
  }
  if (event.status === "active") {
    const [retirement] = await tx
      .select({ id: founderInfrastructureRetirements.id })
      .from(founderInfrastructureRetirements)
      .where(eq(founderInfrastructureRetirements.userId, input.userId))
      .limit(1);
    if (retirement) throw new Error("Product Entitlement cannot restart after retirement begins.");
  }
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
      providerStateUpdatedAt: eventOccurredAt,
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
        providerStateUpdatedAt: eventOccurredAt,
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

function isIrreversibleCommerceStatus(status: FounderCommerceStatus): boolean {
  return status === "unpaid" || status === "expired" || status === "refunded";
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

export function founderCommerceTransitionAllows(input: {
  incomingStatus: FounderCommerceStatus;
  currentStatus: FounderCommerceStatus;
  currentRetirementDueAt: Date | null;
  now: Date;
  retirementStarted: boolean;
}): boolean {
  if (input.incomingStatus !== "active") return true;
  if (input.retirementStarted) return false;
  if (isIrreversibleCommerceStatus(input.currentStatus)) return false;
  return input.currentRetirementDueAt === null || input.currentRetirementDueAt > input.now;
}

export function assertFounderSubscriptionLifecycleContract(now: Date): void {
  const occurredAt = now.toISOString();
  const expected = [
    ["past_due", 7 * 24 * 60 * 60 * 1_000, false],
    ["unpaid", 24 * 60 * 60 * 1_000, true],
    ["expired", 60 * 60 * 1_000, true],
    ["refunded", 24 * 60 * 60 * 1_000, true],
  ] as const;
  for (const [status, duration, stopNewWork] of expected) {
    const policy = founderEntitlementPolicy({
      status,
      occurredAt,
      endsAt: null,
      currentRetirementDueAt: null,
    });
    if (
      policy.retirementDueAt?.valueOf() !== now.valueOf() + duration ||
      policy.stopNewWork !== stopNewWork
    ) {
      throw new Error(`The ${status} Product Entitlement deadline is not exact.`);
    }
  }
  const paidEndsAt = new Date(now.valueOf() + 3 * 24 * 60 * 60 * 1_000);
  const cancellation = founderEntitlementPolicy({
    status: "cancelled",
    occurredAt,
    endsAt: paidEndsAt.toISOString(),
    currentRetirementDueAt: null,
  });
  if (
    cancellation.retirementDueAt?.valueOf() !== paidEndsAt.valueOf() ||
    cancellation.stopNewWork
  ) {
    throw new Error("Cancellation does not preserve operation through paid ends_at.");
  }
  const existingDueAt = new Date(now.valueOf() + 60 * 60 * 1_000);
  if (
    founderEntitlementPolicy({
      status: "past_due",
      occurredAt: new Date(now.valueOf() + 1).toISOString(),
      endsAt: null,
      currentRetirementDueAt: existingDueAt,
    }).retirementDueAt?.valueOf() !== existingDueAt.valueOf()
  ) {
    throw new Error("A reordered commerce event extended a retirement clock.");
  }
  for (const currentStatus of ["unpaid", "expired", "refunded"] as const) {
    if (
      founderCommerceTransitionAllows({
        incomingStatus: "active",
        currentStatus,
        currentRetirementDueAt: new Date(now.valueOf() + 60 * 60 * 1_000),
        now,
        retirementStarted: false,
      })
    ) {
      throw new Error(`A reordered active event restarted the ${currentStatus} retirement clock.`);
    }
  }
}

export type FounderProductEntitlementAuthority = {
  status: "verified" | Exclude<FounderCommerceStatus, "active">;
  retirementDueAt: Date | null;
};

export function founderProductEntitlementAuthorizesWork(
  entitlement: FounderProductEntitlementAuthority,
  now: Date,
): boolean {
  if (entitlement.status === "verified") return true;
  if (entitlement.status === "past_due" || entitlement.status === "cancelled") {
    return entitlement.retirementDueAt !== null && entitlement.retirementDueAt > now;
  }
  return false;
}

export async function requireOperationalEntitlement(
  tx: Transaction,
  userId: string,
  now: Date,
): Promise<void> {
  const [entitlement] = await tx
    .select({
      status: founderProductEntitlements.status,
      retirementDueAt: founderProductEntitlements.retirementDueAt,
    })
    .from(founderProductEntitlements)
    .where(eq(founderProductEntitlements.userId, userId))
    .limit(1);
  if (!entitlement || !founderProductEntitlementAuthorizesWork(entitlement, now)) {
    throw new Error("Operational Product Entitlement is required.");
  }
}

export async function findProductEntitlementRetirementDue(
  tx: Transaction,
  userId: string,
  now: Date,
): Promise<Date | null> {
  const [entitlement] = await tx
    .select({ retirementDueAt: founderProductEntitlements.retirementDueAt })
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
  if (entitlement) {
    if (!entitlement.retirementDueAt) {
      throw new Error("Product Entitlement retirement deadline is unavailable.");
    }
    return entitlement.retirementDueAt;
  }
  const [externalBeta] = await tx
    .select({ retirementDueAt: founderExternalBetaInvitations.retirementDueAt })
    .from(founderExternalBetaInvitations)
    .where(
      and(
        eq(founderExternalBetaInvitations.participantUserId, userId),
        inArray(founderExternalBetaInvitations.status, ["expired", "withdrawn"]),
      ),
    )
    .limit(1);
  return externalBeta?.retirementDueAt ?? null;
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
