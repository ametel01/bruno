import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFounderCheckout,
  getFounderCommerceStatusForUser,
  issueFounderCustomerPortal,
  reconcileFounderCommerceReceipt,
  recordFounderCommerceWebhook,
} from "@/src/server/commerce/founder-commerce";
import { reconcileNextFounderCommerce } from "@/src/server/commerce/founder-commerce-reconciler";
import type {
  LemonSqueezyCommerceProvider,
  ReconciledLemonSqueezyOrder,
  ReconciledLemonSqueezySubscription,
} from "@/src/server/commerce/lemon-squeezy-provider";
import type { VerifiedLemonSqueezyWebhook } from "@/src/server/commerce/lemon-squeezy-webhook";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderCheckoutCorrelations,
  founderCommerceEvents,
  founderCommerceLifecycleReceipts,
  founderProductEntitlements,
  operatorDeletionCommerceCancellations,
  operatorDeletionRequests,
  operatorConversations,
  operators,
  users,
} from "@/src/server/db/schema";
import type { FounderInfrastructureRetirementProvider } from "@/src/server/founder-product-contract/infrastructure-retirement";
import {
  FOUNDER_ACTIVE_PURGE_WINDOW_MS,
  processFounderDeletionRequests,
  requestFounderDeletionForUser,
} from "@/src/server/operators/founder-deletion";

const USER_ID = "00000000-0000-4000-8000-000000000380";
const CORRELATION = "a".repeat(43);
const NEWER_CORRELATION = "b".repeat(43);
const SUBSCRIPTION_ID = "789";
const ORDER_ID = "101";
const STARTED_AT = new Date("2026-08-23T00:00:00.000Z");

describe("persisted Founder commerce authority", () => {
  let connection: DatabaseConnection;
  let subscription: ReconciledLemonSqueezySubscription;
  let order: ReconciledLemonSqueezyOrder;
  let provider: LemonSqueezyCommerceProvider;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await connection.client.unsafe("truncate table users restart identity cascade");
    await connection.db.insert(users).values({ id: USER_ID });
    await connection.db.insert(operators).values({ userId: USER_ID });
    await connection.db.insert(founderCheckoutCorrelations).values({
      userId: USER_ID,
      correlationDigest: digest(CORRELATION),
      createdAt: STARTED_AT,
      expiresAt: new Date("2026-08-23T01:00:00.000Z"),
    });
    subscription = {
      subscriptionId: SUBSCRIPTION_ID,
      orderId: ORDER_ID,
      status: "active",
      updatedAt: "2026-08-23T00:01:00.000Z",
      endsAt: null,
    };
    order = {
      orderId: ORDER_ID,
      status: "paid",
      total: 3000,
      refundedAmount: 0,
      updatedAt: "2026-08-23T00:01:00.000Z",
    };
    provider = {
      createCheckout: vi.fn(),
      createCustomerPortal: vi.fn(async ({ now }) => ({
        portalUrl: signedPortalUrl(now),
        expiresAt: new Date(now.valueOf() + 24 * 60 * 60 * 1_000).toISOString(),
      })),
      readSubscription: vi.fn(async () => subscription),
      readOrder: vi.fn(async () => order),
      cancelSubscription: vi.fn(async () => undefined),
      refundOrder: vi.fn(async () => {
        order = { ...order, status: "refunded", refundedAmount: order.total };
        return order;
      }),
    };
  });

  afterEach(async () => {
    await connection.client.unsafe("truncate table users restart identity cascade");
    await connection.close();
  });

  it("records before provider reconciliation, deduplicates, and ignores reordered delivery", async () => {
    const first = await record(webhook("first", "2026-08-23T00:01:00.000Z"));
    expect(first.duplicate).toBe(false);
    expect(await reconcile(first.receiptId)).toBe("applied");
    expect(await record(webhook("first", "2026-08-23T00:01:00.000Z"))).toMatchObject({
      receiptId: first.receiptId,
      duplicate: true,
    });

    subscription = {
      ...subscription,
      status: "unpaid",
      updatedAt: "2026-08-23T00:03:00.000Z",
    };
    const newer = await record(webhook("newer", "2026-08-23T00:03:00.000Z", null));
    expect(await reconcile(newer.receiptId)).toBe("applied");
    const retirementBefore = (await connection.db.select().from(founderProductEntitlements))[0]
      ?.retirementDueAt;

    const older = await record(webhook("older", "2026-08-23T00:02:00.000Z", null));
    expect(await reconcile(older.receiptId)).toBe("ignored");
    const [entitlement] = await connection.db.select().from(founderProductEntitlements);
    expect(entitlement).toMatchObject({ status: "unpaid", retirementDueAt: retirementBefore });
  });

  it("deduplicates simultaneous signed webhook intake without rejecting either delivery", async () => {
    const firstConnection = createDatabaseConnection();
    const secondConnection = createDatabaseConnection();
    const input = webhook("simultaneous-duplicate-384", subscription.updatedAt);
    try {
      const results = await Promise.all([
        recordFounderCommerceWebhook({
          webhook: input,
          recordedAt: new Date(input.occurredAt),
          createConnection: () => firstConnection,
        }),
        recordFounderCommerceWebhook({
          webhook: input,
          recordedAt: new Date(input.occurredAt),
          createConnection: () => secondConnection,
        }),
      ]);
      expect(new Set(results.map((result) => result.receiptId)).size).toBe(1);
      expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
    } finally {
      await Promise.all([firstConnection.close(), secondConnection.close()]);
    }
  });

  it("permanently fences checkout and ignores a delayed competing subscription after Account Closure", async () => {
    const payment = await record(webhook("closure-fence-payment", subscription.updatedAt));
    expect(await reconcile(payment.receiptId)).toBe("applied");
    await connection.db.insert(founderCheckoutCorrelations).values({
      userId: USER_ID,
      correlationDigest: digest(NEWER_CORRELATION),
      generation: 2,
      createdAt: new Date("2026-08-23T00:02:00.000Z"),
      expiresAt: new Date("2026-08-23T01:02:00.000Z"),
    });
    const delayed = await record(
      webhook("closure-fence-delayed", "2026-08-23T00:03:00.000Z", NEWER_CORRELATION, {
        subscriptionId: "subscription-competing-384",
        orderId: "order-competing-384",
      }),
    );
    const closure = await requestFounderDeletionForUser(
      USER_ID,
      "account_closure",
      {},
      {
        createConnection: () => connection,
        now: () => new Date("2026-08-23T00:04:00.000Z"),
        cancelCommerce: async () => {
          throw new Error("cancellation evidence pending");
        },
        readCommerce: async () => subscription,
        revokeConnections: async () => [],
      },
    );
    expect(closure?.request).toMatchObject({
      status: "failed",
      activePurgeCompletedAt: null,
      failureCode: "account_closure_external_effects_unresolved",
    });

    subscription = {
      subscriptionId: "subscription-competing-384",
      orderId: "order-competing-384",
      status: "active",
      updatedAt: "2026-08-23T00:03:00.000Z",
      endsAt: null,
    };
    order = {
      orderId: "order-competing-384",
      status: "paid",
      total: 3000,
      refundedAmount: 0,
      updatedAt: subscription.updatedAt,
    };
    expect(await reconcile(delayed.receiptId)).toBe("ignored");
    expect(
      await record(
        webhook("closure-fence-delayed", "2026-08-23T00:03:00.000Z", NEWER_CORRELATION, {
          subscriptionId: "subscription-competing-384",
          orderId: "order-competing-384",
        }),
      ),
    ).toMatchObject({ receiptId: delayed.receiptId, duplicate: true });
    expect((await connection.db.select().from(founderProductEntitlements))[0]).toMatchObject({
      providerSubscriptionId: SUBSCRIPTION_ID,
      status: "verified",
    });
    expect(await connection.db.select().from(founderCommerceLifecycleReceipts)).toEqual([]);

    const createCheckout = vi.fn();
    await expect(
      createFounderCheckout({
        userId: USER_ID,
        appUrl: "https://bruno.example",
        now: new Date("2026-08-23T00:05:00.000Z"),
        provider: { ...provider, createCheckout },
        createConnection: () => connection,
      }),
    ).rejects.toThrow("Account Closure permanently fences new commerce");
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("persists a post-closure payment as fenced evidence and blocks purge until cancellation", async () => {
    const closureAt = new Date("2026-08-23T00:01:00.000Z");
    const closure = await requestFounderDeletionForUser(
      USER_ID,
      "account_closure",
      {},
      {
        createConnection: () => connection,
        now: () => closureAt,
        revokeConnections: async () => [],
      },
    );
    expect(closure?.commerceCancellation).toBeNull();
    expect((await connection.db.select().from(founderCheckoutCorrelations))[0]).toMatchObject({
      status: "closed",
      closureReason: "account_closure",
      consumedAt: null,
    });

    const latePayment = webhook("post-closure-payment", "2026-08-23T00:02:00.000Z", CORRELATION, {
      subscriptionId: "subscription-post-closure-384",
      orderId: "order-post-closure-384",
    });
    const fenced = await recordFounderCommerceWebhook({
      webhook: latePayment,
      recordedAt: new Date(latePayment.occurredAt),
      createConnection: () => connection,
    });
    expect(fenced).toMatchObject({ terminal: true, duplicate: false });
    expect(
      await recordFounderCommerceWebhook({
        webhook: latePayment,
        recordedAt: new Date(latePayment.occurredAt),
        createConnection: () => connection,
      }),
    ).toMatchObject({ receiptId: fenced.receiptId, duplicate: true });
    expect((await connection.db.select().from(founderCommerceEvents))[0]).toMatchObject({
      id: fenced.receiptId,
      applicationStatus: "ignored",
      providerSubscriptionId: "subscription-post-closure-384",
    });
    expect(await connection.db.select().from(operatorDeletionCommerceCancellations)).toEqual([
      expect.objectContaining({
        requestId: closure?.request.id,
        providerSubscriptionId: "subscription-post-closure-384",
        status: "pending",
      }),
    ]);

    const processed = await processFounderDeletionRequests({
      createConnection: () => connection,
      now: () => new Date(closureAt.valueOf() + FOUNDER_ACTIVE_PURGE_WINDOW_MS),
      cancelCommerce: async () => {
        throw new Error("provider cancellation pending");
      },
      readCommerce: async () => subscription,
      revokeConnections: async () => [],
    });
    expect(processed).toEqual({ processed: 1, failed: 0 });
    expect(
      (await connection.db.select().from(operatorDeletionCommerceCancellations))[0],
    ).toMatchObject({ status: "failed", errorCode: "commerce_cancellation_unconfirmed" });
    expect(await connection.db.select().from(founderProductEntitlements)).toEqual([]);

    subscription = {
      subscriptionId: "subscription-post-closure-384",
      orderId: "order-post-closure-384",
      status: "cancelled",
      updatedAt: "2026-08-23T00:03:00.000Z",
      endsAt: "2026-08-30T00:00:00.000Z",
    };
    order = {
      orderId: subscription.orderId,
      status: "paid",
      total: 3000,
      refundedAmount: 0,
      updatedAt: "2026-08-23T00:04:00.000Z",
    };
    const cancellation = await record(
      webhook("post-closure-cancellation", subscription.updatedAt, CORRELATION, {
        subscriptionId: subscription.subscriptionId,
        orderId: subscription.orderId,
      }),
    );
    expect(await reconcile(cancellation.receiptId)).toBe("applied");
    expect(
      await record(
        webhook("post-closure-cancellation", subscription.updatedAt, CORRELATION, {
          subscriptionId: subscription.subscriptionId,
          orderId: subscription.orderId,
        }),
      ),
    ).toMatchObject({ receiptId: cancellation.receiptId, duplicate: true });
    await processFounderDeletionRequests({
      createConnection: () => connection,
      now: () => new Date(closureAt.valueOf() + FOUNDER_ACTIVE_PURGE_WINDOW_MS + 1),
      cancelCommerce: async () => undefined,
      readCommerce: async () => subscription,
      revokeConnections: async () => [],
    });
    expect(
      (await connection.db.select().from(operatorDeletionCommerceCancellations))[0],
    ).toMatchObject({ status: "succeeded", errorCode: null });
    expect((await connection.db.select().from(founderProductEntitlements))[0]).toMatchObject({
      sourceEventId: cancellation.receiptId,
      providerSubscriptionId: subscription.subscriptionId,
      providerStateUpdatedAt: new Date(order.updatedAt),
    });
    expect(await connection.db.select().from(founderCommerceLifecycleReceipts)).toEqual([
      expect.objectContaining({
        sourceEventId: cancellation.receiptId,
        providerSubscriptionId: subscription.subscriptionId,
        kind: "cancellation",
        effectiveAt: new Date("2026-08-30T00:00:00.000Z"),
        occurredAt: new Date(order.updatedAt),
      }),
    ]);
  });

  it("reconciles multiple Account Closure cancellations in reverse generation order", async () => {
    const closureAt = new Date("2026-08-23T00:01:00.000Z");
    await connection.db.insert(founderCheckoutCorrelations).values({
      userId: USER_ID,
      correlationDigest: digest(NEWER_CORRELATION),
      generation: 2,
      createdAt: STARTED_AT,
      expiresAt: new Date("2026-08-23T01:00:00.000Z"),
    });
    const closure = await requestFounderDeletionForUser(
      USER_ID,
      "account_closure",
      {},
      {
        createConnection: () => connection,
        now: () => closureAt,
        revokeConnections: async () => [],
      },
    );
    const identities = [
      {
        correlation: CORRELATION,
        subscriptionId: "subscription-closure-a-384",
        orderId: "order-closure-a-384",
        updatedAt: "2026-08-23T00:02:00.000Z",
        endsAt: "2026-08-30T00:00:00.000Z",
      },
      {
        correlation: NEWER_CORRELATION,
        subscriptionId: "subscription-closure-b-384",
        orderId: "order-closure-b-384",
        updatedAt: "2026-08-23T00:03:00.000Z",
        endsAt: "2026-08-31T00:00:00.000Z",
      },
    ] as const;
    for (const identity of identities) {
      await record(
        webhook(
          `late-payment-${identity.subscriptionId}`,
          identity.updatedAt,
          identity.correlation,
          {
            subscriptionId: identity.subscriptionId,
            orderId: identity.orderId,
          },
        ),
      );
    }
    const cancellationReceipts = new Map<string, string>();
    for (const identity of identities) {
      const cancellation = await record(
        webhook(
          `late-cancellation-${identity.subscriptionId}`,
          identity.updatedAt,
          identity.correlation,
          { subscriptionId: identity.subscriptionId, orderId: identity.orderId },
        ),
      );
      cancellationReceipts.set(identity.subscriptionId, cancellation.receiptId);
    }
    for (const identity of [...identities].reverse()) {
      subscription = {
        subscriptionId: identity.subscriptionId,
        orderId: identity.orderId,
        status: "cancelled",
        updatedAt: identity.updatedAt,
        endsAt: identity.endsAt,
      };
      order = {
        orderId: identity.orderId,
        status: "paid",
        total: 3000,
        refundedAmount: 0,
        updatedAt: identity.updatedAt,
      };
      const cancellationReceiptId = cancellationReceipts.get(identity.subscriptionId);
      if (!cancellationReceiptId) throw new Error("cancellation receipt setup missing");
      expect(await reconcile(cancellationReceiptId)).toBe("applied");
    }
    const observations = new Map<string, ReconciledLemonSqueezySubscription>(
      identities.map((identity) => [
        identity.subscriptionId,
        {
          subscriptionId: identity.subscriptionId,
          orderId: identity.orderId,
          status: "cancelled" as const,
          updatedAt: identity.updatedAt,
          endsAt: identity.endsAt,
        },
      ]),
    );
    await processFounderDeletionRequests({
      createConnection: () => connection,
      now: () => new Date(closureAt.valueOf() + FOUNDER_ACTIVE_PURGE_WINDOW_MS),
      cancelCommerce: async () => undefined,
      readCommerce: async (subscriptionId) => {
        const observation = observations.get(subscriptionId);
        if (!observation) throw new Error("unexpected subscription");
        return observation;
      },
      revokeConnections: async () => [],
    });
    expect(
      (
        await connection.db
          .select()
          .from(operatorDeletionCommerceCancellations)
          .orderBy(operatorDeletionCommerceCancellations.providerSubscriptionId)
      ).map((item) => ({ subscriptionId: item.providerSubscriptionId, status: item.status })),
    ).toEqual(
      identities.map((identity) => ({
        subscriptionId: identity.subscriptionId,
        status: "succeeded",
      })),
    );
    expect(await connection.db.select().from(founderCommerceLifecycleReceipts)).toEqual(
      expect.arrayContaining(
        identities.map((identity) =>
          expect.objectContaining({
            sourceEventId: cancellationReceipts.get(identity.subscriptionId),
            providerSubscriptionId: identity.subscriptionId,
            kind: "cancellation",
            effectiveAt: new Date(identity.endsAt),
            occurredAt: new Date(identity.updatedAt),
          }),
        ),
      ),
    );
    expect(closure?.request.id).toBeTruthy();
  });

  it("still cancels a closed paid correlation after its canonical refund", async () => {
    const paidAt = new Date("2026-08-23T00:00:30.000Z");
    const [correlation] = await connection.db
      .update(founderCheckoutCorrelations)
      .set({
        status: "closed",
        providerSubscriptionId: "subscription-refunded-before-closure-384",
        providerOrderId: "order-refunded-before-closure-384",
        consumedAt: paidAt,
        paymentDetectedAt: paidAt,
        reconciliationDueAt: new Date(paidAt.valueOf() + 60 * 60 * 1_000),
        refundRequestedAt: paidAt,
        refundAttemptCount: 1,
        refundedAt: paidAt,
        closedAt: paidAt,
        closureReason: "payment_without_access_refunded",
      })
      .returning({ id: founderCheckoutCorrelations.id });
    if (!correlation) throw new Error("closed correlation setup missing");
    const [event] = await connection.db
      .insert(founderCommerceEvents)
      .values({
        providerEventId: "closed-refund-before-closure-384",
        userId: USER_ID,
        checkoutCorrelationId: correlation.id,
        providerSubscriptionId: "subscription-refunded-before-closure-384",
        providerOrderId: "order-refunded-before-closure-384",
        eventType: "order_refunded",
        payloadDigest: digest("closed-refund-before-closure-384"),
        signatureVerified: true,
        occurredAt: paidAt,
        recordedAt: paidAt,
        applicationStatus: "applied",
        lastAttemptAt: paidAt,
        appliedAt: paidAt,
      })
      .returning({ id: founderCommerceEvents.id });
    if (!event) throw new Error("closed refund event setup missing");
    await connection.db.insert(founderCommerceLifecycleReceipts).values({
      userId: USER_ID,
      sourceEventId: event.id,
      providerSubscriptionId: "subscription-refunded-before-closure-384",
      kind: "refund",
      effectiveAt: paidAt,
      evidenceDigest: digest("closed-refund-receipt-before-closure-384"),
      occurredAt: paidAt,
      createdAt: paidAt,
    });
    let cancellationReceiptId: string | null = null;
    const cancelCommerce = vi.fn(async (subscriptionId: string) => {
      expect(subscriptionId).toBe("subscription-refunded-before-closure-384");
      subscription = {
        subscriptionId,
        orderId: "order-refunded-before-closure-384",
        status: "cancelled",
        updatedAt: "2026-08-23T00:03:00.000Z",
        endsAt: "2026-08-30T00:00:00.000Z",
      };
      order = {
        orderId: subscription.orderId,
        status: "refunded",
        total: 3000,
        refundedAmount: 3000,
        updatedAt: paidAt.toISOString(),
      };
      const cancellation = await record(
        webhook("closed-refund-cancellation-384", subscription.updatedAt, CORRELATION, {
          subscriptionId,
          orderId: subscription.orderId,
        }),
      );
      cancellationReceiptId = cancellation.receiptId;
      expect(await reconcile(cancellation.receiptId)).toBe("applied");
    });
    const closure = await requestFounderDeletionForUser(
      USER_ID,
      "account_closure",
      {},
      {
        createConnection: () => connection,
        now: () => new Date("2026-08-23T00:03:00.000Z"),
        cancelCommerce,
        readCommerce: async () => subscription,
        revokeConnections: async () => [],
      },
    );
    expect(cancelCommerce).toHaveBeenCalledOnce();
    expect(closure?.commerceCancellation).toMatchObject({
      providerSubscriptionId: "subscription-refunded-before-closure-384",
      status: "succeeded",
    });
    expect(await connection.db.select().from(founderCommerceLifecycleReceipts)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceEventId: event.id, kind: "refund" }),
        expect.objectContaining({ sourceEventId: cancellationReceiptId, kind: "cancellation" }),
      ]),
    );
  });

  it("keeps refund evidence separate while cancelling a currently refunded subscription", async () => {
    const payment = await record(webhook("closure-refund-payment", subscription.updatedAt));
    expect(await reconcile(payment.receiptId)).toBe("applied");
    order = {
      ...order,
      status: "refunded",
      refundedAmount: order.total,
      updatedAt: "2026-08-23T00:02:00.000Z",
    };
    const refund = await record(webhook("closure-current-refund", order.updatedAt, null));
    expect(await reconcile(refund.receiptId)).toBe("applied");
    let cancellationReceiptId: string | null = null;
    const cancelCommerce = vi.fn(async (subscriptionId: string) => {
      expect(subscriptionId).toBe(SUBSCRIPTION_ID);
      subscription = {
        ...subscription,
        status: "cancelled",
        updatedAt: "2026-08-23T00:04:00.000Z",
        endsAt: "2026-08-30T00:00:00.000Z",
      };
      const cancellation = await record(
        webhook("closure-current-refund-cancellation", subscription.updatedAt, null),
      );
      cancellationReceiptId = cancellation.receiptId;
      expect(await reconcile(cancellation.receiptId)).toBe("applied");
    });
    const closure = await requestFounderDeletionForUser(
      USER_ID,
      "account_closure",
      {},
      {
        createConnection: () => connection,
        now: () => new Date("2026-08-23T00:04:00.000Z"),
        cancelCommerce,
        readCommerce: async () => subscription,
        revokeConnections: async () => [],
      },
    );
    expect(cancelCommerce).toHaveBeenCalledOnce();
    expect(closure?.commerceCancellation).toMatchObject({
      providerSubscriptionId: SUBSCRIPTION_ID,
      status: "succeeded",
    });
    expect((await connection.db.select().from(founderProductEntitlements))[0]).toMatchObject({
      status: "refunded",
      sourceEventId: cancellationReceiptId,
    });
    expect(await connection.db.select().from(founderCommerceLifecycleReceipts)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceEventId: refund.receiptId, kind: "refund" }),
        expect.objectContaining({ sourceEventId: cancellationReceiptId, kind: "refund" }),
        expect.objectContaining({ sourceEventId: cancellationReceiptId, kind: "cancellation" }),
      ]),
    );
  });

  it.each([
    "partial_refund",
    "failed",
    "fraudulent",
  ] as const)("records cancellation independently when a %s order keeps entitlement unpaid", async (orderStatus) => {
    const payment = await record(webhook(`closure-${orderStatus}-payment`, subscription.updatedAt));
    expect(await reconcile(payment.receiptId)).toBe("applied");
    order = {
      ...order,
      status: orderStatus,
      refundedAmount: orderStatus === "partial_refund" ? 1000 : 0,
      updatedAt: "2026-08-23T00:02:00.000Z",
    };
    const nonPaidOrder = await record(webhook(`closure-${orderStatus}`, order.updatedAt, null));
    expect(await reconcile(nonPaidOrder.receiptId)).toBe("applied");

    let cancellationReceiptId: string | null = null;
    const cancelCommerce = vi.fn(async (subscriptionId: string) => {
      expect(subscriptionId).toBe(SUBSCRIPTION_ID);
      subscription = {
        ...subscription,
        status: "cancelled",
        updatedAt: "2026-08-23T00:04:00.000Z",
        endsAt: "2026-08-30T00:00:00.000Z",
      };
      const cancellation = await record(
        webhook(`closure-${orderStatus}-cancellation`, subscription.updatedAt, null),
      );
      cancellationReceiptId = cancellation.receiptId;
      expect(await reconcile(cancellation.receiptId)).toBe("applied");
    });
    const closure = await requestFounderDeletionForUser(
      USER_ID,
      "account_closure",
      {},
      {
        createConnection: () => connection,
        now: () => new Date("2026-08-23T00:04:00.000Z"),
        cancelCommerce,
        readCommerce: async () => subscription,
        revokeConnections: async () => [],
      },
    );

    expect(cancelCommerce).toHaveBeenCalledOnce();
    expect(closure?.commerceCancellation).toMatchObject({
      providerSubscriptionId: SUBSCRIPTION_ID,
      status: "succeeded",
    });
    expect((await connection.db.select().from(founderProductEntitlements))[0]).toMatchObject({
      status: "unpaid",
      sourceEventId: cancellationReceiptId,
    });
    expect(await connection.db.select().from(founderCommerceLifecycleReceipts)).toEqual([
      expect.objectContaining({
        sourceEventId: cancellationReceiptId,
        kind: "cancellation",
        occurredAt: new Date(subscription.updatedAt),
      }),
    ]);
  });

  it("lets a current resumed entitlement dominate its historical cancellation receipt", async () => {
    const payment = await record(webhook("closure-resume-payment", subscription.updatedAt));
    expect(await reconcile(payment.receiptId)).toBe("applied");
    subscription = {
      ...subscription,
      status: "cancelled",
      updatedAt: "2026-08-23T00:02:00.000Z",
      endsAt: "2026-08-30T00:00:00.000Z",
    };
    order = { ...order, updatedAt: subscription.updatedAt };
    const cancellation = await record(
      webhook("closure-resume-cancellation", subscription.updatedAt, null),
    );
    expect(await reconcile(cancellation.receiptId)).toBe("applied");
    subscription = {
      ...subscription,
      status: "active",
      updatedAt: "2026-08-23T00:03:00.000Z",
      endsAt: null,
    };
    order = { ...order, updatedAt: subscription.updatedAt };
    const resumed = await record(webhook("closure-resume-active", subscription.updatedAt, null));
    expect(await reconcile(resumed.receiptId)).toBe("applied");
    const cancelCommerce = vi.fn(async () => undefined);
    const closure = await requestFounderDeletionForUser(
      USER_ID,
      "account_closure",
      {},
      {
        createConnection: () => connection,
        now: () => new Date("2026-08-23T00:04:00.000Z"),
        cancelCommerce,
        readCommerce: async () => ({
          subscriptionId: SUBSCRIPTION_ID,
          orderId: ORDER_ID,
          status: "cancelled" as const,
          updatedAt: "2026-08-23T00:02:00.000Z",
          endsAt: "2026-08-30T00:00:00.000Z",
        }),
        revokeConnections: async () => [],
      },
    );
    expect(cancelCommerce).toHaveBeenCalledWith(SUBSCRIPTION_ID);
    expect(closure?.commerceCancellation).toMatchObject({
      providerSubscriptionId: SUBSCRIPTION_ID,
      status: "failed",
      errorCode: "commerce_cancellation_unconfirmed",
    });
  });

  it("requires fresh cancellation authority for a resumed subscription displaced by a newer one", async () => {
    const paymentA = await record(webhook("displaced-a-payment", subscription.updatedAt));
    expect(await reconcile(paymentA.receiptId)).toBe("applied");
    subscription = {
      ...subscription,
      status: "cancelled",
      updatedAt: "2026-08-23T00:02:00.000Z",
      endsAt: "2026-08-30T00:00:00.000Z",
    };
    order = { ...order, updatedAt: subscription.updatedAt };
    const cancellationA = await record(
      webhook("displaced-a-cancellation", subscription.updatedAt, null),
    );
    expect(await reconcile(cancellationA.receiptId)).toBe("applied");

    await connection.db.insert(founderCheckoutCorrelations).values({
      userId: USER_ID,
      correlationDigest: digest(NEWER_CORRELATION),
      generation: 2,
      createdAt: new Date("2026-08-23T00:02:30.000Z"),
      expiresAt: new Date("2026-08-23T01:02:30.000Z"),
    });
    subscription = {
      subscriptionId: "subscription-displacing-b-384",
      orderId: "order-displacing-b-384",
      status: "active",
      updatedAt: "2026-08-23T00:03:00.000Z",
      endsAt: null,
    };
    order = {
      orderId: subscription.orderId,
      status: "paid",
      total: 3000,
      refundedAmount: 0,
      updatedAt: subscription.updatedAt,
    };
    const paymentB = await record(
      webhook("displacing-b-payment", subscription.updatedAt, NEWER_CORRELATION, {
        subscriptionId: subscription.subscriptionId,
        orderId: subscription.orderId,
      }),
    );
    expect(await reconcile(paymentB.receiptId)).toBe("applied");

    subscription = {
      subscriptionId: SUBSCRIPTION_ID,
      orderId: ORDER_ID,
      status: "active",
      updatedAt: "2026-08-23T00:04:00.000Z",
      endsAt: null,
    };
    order = {
      orderId: ORDER_ID,
      status: "paid",
      total: 3000,
      refundedAmount: 0,
      updatedAt: subscription.updatedAt,
    };
    const resumedA = await record(webhook("displaced-a-resumed", subscription.updatedAt, null));
    expect(await reconcile(resumedA.receiptId)).toBe("ignored");

    const cancelCommerce = vi.fn(async () => undefined);
    const closure = await requestFounderDeletionForUser(
      USER_ID,
      "account_closure",
      {},
      {
        createConnection: () => connection,
        now: () => new Date("2026-08-23T00:05:00.000Z"),
        cancelCommerce,
        readCommerce: async (subscriptionId) =>
          subscriptionId === SUBSCRIPTION_ID
            ? {
                subscriptionId: SUBSCRIPTION_ID,
                orderId: ORDER_ID,
                status: "cancelled" as const,
                updatedAt: "2026-08-23T00:02:00.000Z",
                endsAt: "2026-08-30T00:00:00.000Z",
              }
            : {
                subscriptionId: "subscription-displacing-b-384",
                orderId: "order-displacing-b-384",
                status: "active" as const,
                updatedAt: "2026-08-23T00:03:00.000Z",
                endsAt: null,
              },
        revokeConnections: async () => [],
      },
    );
    expect(cancelCommerce).toHaveBeenCalledTimes(2);
    expect(cancelCommerce).toHaveBeenCalledWith(SUBSCRIPTION_ID);
    expect(
      closure?.commerceCancellations.find(
        (item) => item.providerSubscriptionId === SUBSCRIPTION_ID,
      ),
    ).toMatchObject({ status: "failed", errorCode: "commerce_cancellation_unconfirmed" });
  });

  it("settles durable webhook intake before purge so a late payment preserves content", async () => {
    const closureAt = new Date("2026-08-23T00:01:00.000Z");
    const [operator] = await connection.db
      .select({ id: operators.id })
      .from(operators)
      .where(eq(operators.userId, USER_ID))
      .limit(1);
    if (!operator) throw new Error("operator setup missing");
    const conversationId = "00000000-0000-4000-8000-000000000384";
    await connection.db.insert(operatorConversations).values({
      id: conversationId,
      operatorId: operator.id,
      createdAt: STARTED_AT,
      updatedAt: STARTED_AT,
    });
    await requestFounderDeletionForUser(
      USER_ID,
      "account_closure",
      {},
      {
        createConnection: () => connection,
        now: () => closureAt,
        revokeConnections: async () => [],
      },
    );

    const databaseUrl = loopbackDatabaseUrl();
    const blocker = postgres(databaseUrl, { max: 1 });
    const observer = postgres(databaseUrl, { max: 1 });
    const processConnection = createDatabaseConnection();
    const webhookConnection = createDatabaseConnection();
    let releaseConversationLock: () => void = () => undefined;
    let reportConversationLocked: () => void = () => undefined;
    const conversationLockReleased = new Promise<void>((resolve) => {
      releaseConversationLock = resolve;
    });
    const conversationLocked = new Promise<void>((resolve) => {
      reportConversationLocked = resolve;
    });
    const blockerWork = blocker.begin(async (tx) => {
      await tx`select id from operator_conversations where id = ${conversationId} for update`;
      reportConversationLocked();
      await conversationLockReleased;
    });

    await conversationLocked;
    const processing = processFounderDeletionRequests({
      createConnection: () => processConnection,
      now: () => new Date(closureAt.valueOf() + FOUNDER_ACTIVE_PURGE_WINDOW_MS),
      revokeConnections: async () => [],
    });
    try {
      await waitForBlockedDatabaseSessions(observer, 1);
      const lateWebhook = webhook(
        "purge-race-late-payment-384",
        "2026-08-23T00:02:00.000Z",
        CORRELATION,
        {
          subscriptionId: "subscription-purge-race-384",
          orderId: "order-purge-race-384",
        },
      );
      const recorded = recordFounderCommerceWebhook({
        webhook: lateWebhook,
        recordedAt: new Date(lateWebhook.occurredAt),
        createConnection: () => webhookConnection,
      });
      await waitForBlockedDatabaseSessions(observer, 2);
      expect(
        await Promise.race([
          recorded.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
        ]),
      ).toBe(false);
      releaseConversationLock();
      await blockerWork;
      await expect(processing).resolves.toEqual({ processed: 1, failed: 0 });
      await expect(recorded).resolves.toMatchObject({ terminal: true, duplicate: false });
      expect(await connection.db.select().from(operatorConversations)).toEqual([
        expect.objectContaining({ id: conversationId }),
      ]);
      expect(await connection.db.select().from(operatorDeletionRequests)).toEqual([
        expect.objectContaining({
          status: "failed",
          activePurgeCompletedAt: null,
          failureCode: "account_closure_external_effects_unresolved",
        }),
      ]);
      expect(await connection.db.select().from(operatorDeletionCommerceCancellations)).toEqual([
        expect.objectContaining({
          providerSubscriptionId: "subscription-purge-race-384",
          status: "pending",
        }),
      ]);
    } finally {
      releaseConversationLock();
      await Promise.allSettled([blockerWork, processing]);
      await Promise.all([
        processConnection.close(),
        webhookConnection.close(),
        blocker.end(),
        observer.end(),
      ]);
    }
  });

  it("settles durable webhook intake before backup expiry and Operator archive", async () => {
    const closureAt = new Date("2026-08-23T00:01:00.000Z");
    const closure = await requestFounderDeletionForUser(
      USER_ID,
      "account_closure",
      {},
      {
        createConnection: () => connection,
        now: () => closureAt,
        revokeConnections: async () => [],
      },
    );
    if (!closure) throw new Error("closure setup missing");
    await processFounderDeletionRequests({
      createConnection: () => connection,
      now: () => new Date(closureAt.valueOf() + FOUNDER_ACTIVE_PURGE_WINDOW_MS),
      revokeConnections: async () => [],
    });
    expect((await connection.db.select().from(operatorDeletionRequests))[0]).toMatchObject({
      status: "backup_expiry_pending",
      activePurgeCompletedAt: new Date(closureAt.valueOf() + FOUNDER_ACTIVE_PURGE_WINDOW_MS),
    });

    const databaseUrl = loopbackDatabaseUrl();
    const blocker = postgres(databaseUrl, { max: 1 });
    const observer = postgres(databaseUrl, { max: 1 });
    const processConnection = createDatabaseConnection();
    const webhookConnection = createDatabaseConnection();
    let releaseBackupLock: () => void = () => undefined;
    let reportBackupLocked: () => void = () => undefined;
    const backupLockReleased = new Promise<void>((resolve) => {
      releaseBackupLock = resolve;
    });
    const backupLocked = new Promise<void>((resolve) => {
      reportBackupLocked = resolve;
    });
    const blockerWork = blocker.begin(async (tx) => {
      await tx`
        select id from operator_deletion_backup_expiries
        where request_id = ${closure.request.id}
        for update
      `;
      reportBackupLocked();
      await backupLockReleased;
    });

    await backupLocked;
    const processing = processFounderDeletionRequests({
      createConnection: () => processConnection,
      now: () => new Date(closureAt.valueOf() + 30 * 24 * 60 * 60 * 1_000),
      revokeConnections: async () => [],
    });
    try {
      await waitForBlockedDatabaseSessions(observer, 1);
      const lateWebhook = webhook(
        "archive-race-late-payment-384",
        "2026-08-23T00:02:00.000Z",
        CORRELATION,
        {
          subscriptionId: "subscription-archive-race-384",
          orderId: "order-archive-race-384",
        },
      );
      const recorded = recordFounderCommerceWebhook({
        webhook: lateWebhook,
        recordedAt: new Date(lateWebhook.occurredAt),
        createConnection: () => webhookConnection,
      });
      await waitForBlockedDatabaseSessions(observer, 2);
      releaseBackupLock();
      await blockerWork;
      await expect(processing).resolves.toEqual({ processed: 1, failed: 0 });
      await expect(recorded).resolves.toMatchObject({ terminal: true, duplicate: false });
      expect((await connection.db.select().from(operatorDeletionRequests))[0]).toMatchObject({
        status: "failed",
        backupExpiredAt: null,
        completedAt: null,
        failureCode: "account_closure_external_effects_unresolved",
      });
      expect((await connection.db.select().from(operators))[0]).toMatchObject({
        status: "active",
        archivedAt: null,
      });
      expect(await connection.db.select().from(operatorDeletionCommerceCancellations)).toEqual([
        expect.objectContaining({
          providerSubscriptionId: "subscription-archive-race-384",
          status: "pending",
        }),
      ]);
    } finally {
      releaseBackupLock();
      await Promise.allSettled([blockerWork, processing]);
      await Promise.all([
        processConnection.close(),
        webhookConnection.close(),
        blocker.end(),
        observer.end(),
      ]);
    }
  });

  it("treats a consumed checkout without a reconciled entitlement as unresolved closure commerce", async () => {
    const paidAt = new Date("2026-08-23T00:01:00.000Z");
    await connection.db.update(founderCheckoutCorrelations).set({
      status: "consumed",
      providerSubscriptionId: "subscription-unreconciled-384",
      providerOrderId: "order-unreconciled-384",
      consumedAt: paidAt,
      paymentDetectedAt: paidAt,
      reconciliationDueAt: new Date(paidAt.valueOf() + 60 * 60 * 1_000),
    });
    const closure = await requestFounderDeletionForUser(
      USER_ID,
      "account_closure",
      {},
      {
        createConnection: () => connection,
        now: () => new Date("2026-08-23T00:02:00.000Z"),
        cancelCommerce: async () => {
          throw new Error("provider cancellation pending");
        },
        readCommerce: async () => subscription,
        revokeConnections: async () => [],
      },
    );
    expect(closure?.request).toMatchObject({
      status: "failed",
      activePurgeCompletedAt: null,
      failureCode: "account_closure_external_effects_unresolved",
    });
    expect(closure?.commerceCancellation).toMatchObject({
      status: "failed",
      errorCode: "commerce_cancellation_unconfirmed",
    });
    expect(await connection.db.select().from(operatorDeletionCommerceCancellations)).toEqual([
      expect.objectContaining({
        providerSubscriptionId: "subscription-unreconciled-384",
        status: "failed",
      }),
    ]);
  });

  it("binds one opaque checkout to the internal Owner without granting access", async () => {
    provider.createCheckout = vi.fn(async ({ checkoutCorrelation }) => ({
      checkoutId: "999",
      checkoutUrl: "https://bruno.lemonsqueezy.com/checkout/buy/test",
      checkoutCorrelation,
    }));

    await expect(
      createFounderCheckout({
        userId: USER_ID,
        appUrl: "http://localhost:3000",
        now: STARTED_AT,
        provider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({
      checkoutUrl: "https://bruno.lemonsqueezy.com/checkout/buy/test",
    });
    const attempts = await connection.db.select().from(founderCheckoutCorrelations);
    const created = attempts.find((attempt) => attempt.providerCheckoutId === "999");
    expect(created).toMatchObject({ userId: USER_ID, status: "pending" });
    expect(created?.correlationDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const checkoutInput = vi.mocked(provider.createCheckout).mock.calls[0]?.[0];
    expect(checkoutInput?.checkoutCorrelation).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created?.correlationDigest).not.toContain(checkoutInput?.checkoutCorrelation ?? "");
    expect(await connection.db.select().from(founderProductEntitlements)).toEqual([]);
  });

  it("issues a short-lived signed Customer Portal only from current eligible authority", async () => {
    const payment = await record(webhook("portal-payment", "2026-08-23T00:01:00.000Z"));
    expect(await reconcile(payment.receiptId)).toBe("applied");
    const now = new Date("2026-08-23T00:02:00.000Z");

    await expect(
      issueFounderCustomerPortal({
        userId: USER_ID,
        now,
        provider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ portalUrl: signedPortalUrl(now) });
    const [receipt] = await connection.db.select().from(founderCommerceLifecycleReceipts);
    expect(receipt).toMatchObject({
      userId: USER_ID,
      providerSubscriptionId: SUBSCRIPTION_ID,
      kind: "portal_issued",
      effectiveAt: null,
      portalExpiresAt: new Date("2026-08-24T00:02:00.000Z"),
    });
    expect(receipt?.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain("signature=");

    subscription = {
      ...subscription,
      status: "unpaid",
      updatedAt: "2026-08-23T00:03:00.000Z",
    };
    const unpaid = await record(webhook("portal-unpaid", subscription.updatedAt, null));
    expect(await reconcile(unpaid.receiptId)).toBe("applied");
    await expect(
      issueFounderCustomerPortal({
        userId: USER_ID,
        now: new Date("2026-08-23T00:04:00.000Z"),
        provider,
        createConnection: () => connection,
      }),
    ).rejects.toThrow("unavailable for this commerce state");
    expect(provider.createCustomerPortal).toHaveBeenCalledTimes(1);
  });

  it("keeps cancellation and refund receipts distinct from other lifecycle receipts", async () => {
    const payment = await record(webhook("receipt-payment", "2026-08-23T00:01:00.000Z"));
    expect(await reconcile(payment.receiptId)).toBe("applied");
    subscription = {
      ...subscription,
      status: "cancelled",
      updatedAt: "2026-08-23T00:02:00.000Z",
      endsAt: "2026-08-30T00:00:00.000Z",
    };
    const cancellation = await record(
      webhook("receipt-cancellation", subscription.updatedAt, null),
    );
    expect(await reconcile(cancellation.receiptId)).toBe("applied");
    expect(await reconcile(cancellation.receiptId)).toBe("ignored");

    order = {
      ...order,
      status: "refunded",
      refundedAmount: order.total,
      updatedAt: "2026-08-23T00:03:00.000Z",
    };
    const refund = await record(webhook("receipt-refund", order.updatedAt, null));
    expect(await reconcile(refund.receiptId)).toBe("applied");

    expect(
      (await connection.db.select().from(founderCommerceLifecycleReceipts)).map((receipt) => ({
        kind: receipt.kind,
        effectiveAt: receipt.effectiveAt,
      })),
    ).toEqual([
      { kind: "cancellation", effectiveAt: new Date("2026-08-30T00:00:00.000Z") },
      { kind: "refund", effectiveAt: new Date("2026-08-23T00:03:00.000Z") },
      { kind: "cancellation", effectiveAt: new Date("2026-08-30T00:00:00.000Z") },
    ]);
    await expect(
      connection.client.unsafe(
        "update founder_commerce_lifecycle_receipts set evidence_digest = $1 where kind = 'refund'",
        [digest("mutated")],
      ),
    ).rejects.toThrow("Founder commerce lifecycle receipts are immutable");
  });

  it("allows cancellation resumption but never restarts a terminal retirement clock", async () => {
    const payment = await record(webhook("resume-payment", "2026-08-23T00:01:00.000Z"));
    expect(await reconcile(payment.receiptId)).toBe("applied");
    subscription = {
      ...subscription,
      status: "cancelled",
      updatedAt: "2026-08-23T00:02:00.000Z",
      endsAt: "2026-08-24T00:00:00.000Z",
    };
    const cancellation = await record(webhook("resume-cancel", subscription.updatedAt, null));
    expect(await reconcile(cancellation.receiptId)).toBe("applied");

    subscription = {
      ...subscription,
      status: "active",
      updatedAt: "2026-08-23T12:00:00.000Z",
      endsAt: null,
    };
    order = { ...order, updatedAt: subscription.updatedAt };
    const resumed = await record(webhook("resume-active", subscription.updatedAt, null));
    expect(await reconcile(resumed.receiptId)).toBe("applied");
    expect((await connection.db.select().from(founderProductEntitlements))[0]).toMatchObject({
      status: "verified",
      retirementDueAt: null,
    });

    subscription = {
      ...subscription,
      status: "unpaid",
      updatedAt: "2026-08-23T12:01:00.000Z",
    };
    order = { ...order, updatedAt: subscription.updatedAt };
    const unpaid = await record(webhook("resume-unpaid", subscription.updatedAt, null));
    expect(await reconcile(unpaid.receiptId)).toBe("applied");
    const retirementDueAt = new Date("2026-08-24T12:01:00.000Z");

    subscription = {
      ...subscription,
      status: "active",
      updatedAt: "2026-08-23T12:02:00.000Z",
    };
    order = { ...order, updatedAt: subscription.updatedAt };
    const reordered = await record(webhook("resume-after-terminal", subscription.updatedAt, null));
    expect(
      await reconcileFounderCommerceReceipt({
        receiptId: reordered.receiptId,
        now: new Date(subscription.updatedAt),
        provider,
        createConnection: () => connection,
      }),
    ).toBe("ignored");
    expect((await connection.db.select().from(founderProductEntitlements))[0]).toMatchObject({
      status: "unpaid",
      retirementDueAt,
    });
  });

  it("claims ordinary terminal entitlement retirement exactly when its deadline is due", async () => {
    const payment = await record(webhook("scheduled-payment", "2026-08-23T00:01:00.000Z"));
    expect(await reconcile(payment.receiptId)).toBe("applied");
    subscription = {
      ...subscription,
      status: "unpaid",
      updatedAt: "2026-08-23T00:02:00.000Z",
    };
    const unpaid = await record(webhook("scheduled-unpaid", subscription.updatedAt, null));
    expect(await reconcile(unpaid.receiptId)).toBe("applied");
    const retirementProvider = unavailableRetirementProvider();

    await expect(
      reconcileNextFounderCommerce({
        now: new Date("2026-08-24T00:01:59.999Z"),
        applicationRevision: "a".repeat(40),
        commerceProvider: provider,
        retirementProvider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ processed: 0, outcome: "idle" });
    await expect(
      reconcileNextFounderCommerce({
        now: new Date("2026-08-24T00:02:00.000Z"),
        applicationRevision: "a".repeat(40),
        commerceProvider: provider,
        retirementProvider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ processed: 1, outcome: "retirement_retrying" });
  });

  it("projects payment recovery and stopped-work truth after payment was established", async () => {
    const payment = await record(webhook("status-payment", "2026-08-23T00:01:00.000Z"));
    expect(await reconcile(payment.receiptId)).toBe("applied");
    subscription = {
      ...subscription,
      status: "past_due",
      updatedAt: "2026-08-23T00:02:00.000Z",
    };
    const pastDue = await record(webhook("status-past-due", subscription.updatedAt, null));
    expect(await reconcile(pastDue.receiptId)).toBe("applied");

    await expect(
      getFounderCommerceStatusForUser(USER_ID, {
        now: new Date("2026-08-29T23:59:59.999Z"),
        createConnection: () => connection,
      }),
    ).resolves.toEqual({
      state: "payment_recovery",
      recoveryEndsAt: "2026-08-30T00:02:00.000Z",
      customerPortalAvailable: true,
    });
    await expect(
      getFounderCommerceStatusForUser(USER_ID, {
        now: new Date("2026-08-30T00:02:00.000Z"),
        createConnection: () => connection,
      }),
    ).resolves.toEqual({
      state: "work_stopped",
      reason: "past_due",
      retirementDueAt: "2026-08-30T00:02:00.000Z",
      retirement: "required",
    });
  });

  it("retains a verified receipt when the provider read fails", async () => {
    provider.readSubscription = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const receipt = await record(webhook("provider-failure", "2026-08-23T00:01:00.000Z"));

    expect(await reconcile(receipt.receiptId)).toBe("confirming_payment");
    const [stored] = await connection.db.select().from(founderCommerceEvents);
    expect(stored).toMatchObject({
      id: receipt.receiptId,
      signatureVerified: true,
      applicationStatus: "pending",
      lastErrorCode: "provider_reconciliation_unavailable",
    });
    expect(await connection.db.select().from(founderProductEntitlements)).toEqual([]);
  });

  it("applies a newer Order refund when the Subscription timestamp does not change", async () => {
    const payment = await record(webhook("payment", "2026-08-23T00:01:00.000Z"));
    expect(await reconcile(payment.receiptId)).toBe("applied");

    order = {
      ...order,
      status: "refunded",
      refundedAmount: order.total,
      updatedAt: "2026-08-23T00:04:00.000Z",
    };
    const refund = await record(webhook("order-refund", order.updatedAt, null));
    expect(
      await reconcileFounderCommerceReceipt({
        receiptId: refund.receiptId,
        now: new Date(order.updatedAt),
        provider,
        createConnection: () => connection,
      }),
    ).toBe("applied");
    expect((await connection.db.select().from(founderProductEntitlements))[0]).toMatchObject({
      status: "refunded",
      providerStateUpdatedAt: new Date(order.updatedAt),
      retirementDueAt: new Date("2026-08-24T00:04:00.000Z"),
    });
  });

  it("does not let an older Checkout Correlation replace a newer entitlement", async () => {
    const first = await record(webhook("first-generation", "2026-08-23T00:01:00.000Z"));
    expect(await reconcile(first.receiptId)).toBe("applied");
    await connection.db.insert(founderCheckoutCorrelations).values({
      userId: USER_ID,
      correlationDigest: digest(NEWER_CORRELATION),
      generation: 2,
      createdAt: new Date("2026-08-23T00:02:00.000Z"),
      expiresAt: new Date("2026-08-23T01:02:00.000Z"),
    });

    subscription = {
      subscriptionId: "790",
      orderId: "102",
      status: "active",
      updatedAt: "2026-08-23T00:03:00.000Z",
      endsAt: null,
    };
    order = {
      orderId: "102",
      status: "paid",
      total: 3000,
      refundedAmount: 0,
      updatedAt: "2026-08-23T00:03:00.000Z",
    };
    const newer = await record(
      webhook("second-generation", subscription.updatedAt, NEWER_CORRELATION, {
        subscriptionId: subscription.subscriptionId,
        orderId: order.orderId,
      }),
    );
    expect(await reconcile(newer.receiptId)).toBe("applied");

    subscription = {
      subscriptionId: SUBSCRIPTION_ID,
      orderId: ORDER_ID,
      status: "unpaid",
      updatedAt: "2026-08-23T00:04:00.000Z",
      endsAt: null,
    };
    order = { ...order, orderId: ORDER_ID, status: "paid", updatedAt: subscription.updatedAt };
    const delayed = await record(
      webhook("delayed-first-generation", subscription.updatedAt, null, {
        subscriptionId: SUBSCRIPTION_ID,
        orderId: ORDER_ID,
      }),
    );
    expect(await reconcile(delayed.receiptId)).toBe("ignored");
    expect((await connection.db.select().from(founderProductEntitlements))[0]).toMatchObject({
      providerSubscriptionId: "790",
      status: "verified",
    });

    const retirementProvider = {
      createRecoveryArchive: vi.fn(),
      deleteRecoveryArchive: vi.fn(),
      digitalOcean: {
        observeOwnedSet: vi.fn(),
        deleteFirewall: vi.fn(),
        deleteDroplet: vi.fn(),
      },
      calls: () => [],
    } as unknown as FounderInfrastructureRetirementProvider;
    await expect(
      reconcileNextFounderCommerce({
        now: new Date("2026-08-23T01:01:00.000Z"),
        applicationRevision: "a".repeat(40),
        commerceProvider: provider,
        retirementProvider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ processed: 1, outcome: "refund_confirmed" });
    expect(provider.refundOrder).toHaveBeenCalledTimes(1);
    expect((await connection.db.select().from(founderProductEntitlements))[0]).toMatchObject({
      providerSubscriptionId: "790",
      status: "verified",
    });
    expect((await connection.db.select().from(operators))[0]).toMatchObject({
      externalActionPause: false,
    });
    expect(
      (await connection.db.select().from(founderCheckoutCorrelations)).find(
        (attempt) => attempt.generation === 1,
      ),
    ).toMatchObject({
      status: "closed",
      closureReason: "payment_without_access_refunded_superseded",
    });
    expect(retirementProvider.createRecoveryArchive).not.toHaveBeenCalled();
  });

  it("refunds once after one hour, terminally fences late success, and requires fresh checkout", async () => {
    const receipt = await record(webhook("timeout", "2026-08-23T00:00:00.000Z"));
    const retirementProvider = {
      createRecoveryArchive: vi.fn(async () => {
        throw new Error("no runtime archive needed in fixture");
      }),
      deleteRecoveryArchive: vi.fn(),
      digitalOcean: {
        observeOwnedSet: vi.fn(),
        deleteFirewall: vi.fn(),
        deleteDroplet: vi.fn(),
      },
      calls: () => [],
    } as unknown as FounderInfrastructureRetirementProvider;

    const result = await reconcileNextFounderCommerce({
      now: new Date("2026-08-23T01:00:00.000Z"),
      applicationRevision: "a".repeat(40),
      commerceProvider: provider,
      retirementProvider,
      createConnection: () => connection,
    });
    expect(result).toEqual({ processed: 1, outcome: "refund_confirmed" });
    expect(provider.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(provider.refundOrder).toHaveBeenCalledTimes(1);
    const [attempt] = await connection.db.select().from(founderCheckoutCorrelations);
    const [entitlement] = await connection.db.select().from(founderProductEntitlements);
    expect(attempt).toMatchObject({
      status: "closed",
      closureReason: "payment_without_access_refunded",
      refundAttemptCount: 1,
    });
    expect(entitlement).toMatchObject({ status: "refunded" });

    const late = await record(webhook("late-success", "2026-08-23T01:01:00.000Z", null));
    expect(late.terminal).toBe(true);
    expect(await reconcile(late.receiptId)).toBe("ignored");
    expect((await connection.db.select().from(founderProductEntitlements))[0]).toMatchObject({
      status: "refunded",
    });
    expect(receipt.receiptId).not.toBe(late.receiptId);
  });

  it("still cancels the subscription when an earlier ambiguous refund already completed", async () => {
    await record(webhook("ambiguous-refund", "2026-08-23T00:00:00.000Z"));
    order = { ...order, status: "refunded", refundedAmount: order.total };
    const retirementProvider = {
      createRecoveryArchive: vi.fn(async () => {
        throw new Error("no runtime archive needed in fixture");
      }),
      deleteRecoveryArchive: vi.fn(),
      digitalOcean: {
        observeOwnedSet: vi.fn(),
        deleteFirewall: vi.fn(),
        deleteDroplet: vi.fn(),
      },
      calls: () => [],
    } as unknown as FounderInfrastructureRetirementProvider;

    await expect(
      reconcileNextFounderCommerce({
        now: new Date("2026-08-23T01:00:00.000Z"),
        applicationRevision: "a".repeat(40),
        commerceProvider: provider,
        retirementProvider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ processed: 1, outcome: "refund_confirmed" });
    expect(provider.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(provider.refundOrder).not.toHaveBeenCalled();
  });

  it("retires an obsolete cleanup retry when a newer checkout has established access", async () => {
    await record(webhook("old-timeout", "2026-08-23T00:00:00.000Z"));
    const retirementProvider = {
      createRecoveryArchive: vi.fn(async () => {
        throw new Error("no runtime archive needed in fixture");
      }),
      deleteRecoveryArchive: vi.fn(),
      digitalOcean: {
        observeOwnedSet: vi.fn(),
        deleteFirewall: vi.fn(),
        deleteDroplet: vi.fn(),
      },
      calls: () => [],
    } as unknown as FounderInfrastructureRetirementProvider;
    await reconcileNextFounderCommerce({
      now: new Date("2026-08-23T01:00:00.000Z"),
      applicationRevision: "a".repeat(40),
      commerceProvider: provider,
      retirementProvider,
      createConnection: () => connection,
    });

    await connection.db.insert(founderCheckoutCorrelations).values({
      userId: USER_ID,
      correlationDigest: digest(NEWER_CORRELATION),
      generation: 2,
      createdAt: new Date("2026-08-23T01:01:00.000Z"),
      expiresAt: new Date("2026-08-23T02:01:00.000Z"),
    });
    subscription = {
      subscriptionId: "790",
      orderId: "102",
      status: "active",
      updatedAt: "2026-08-23T01:01:00.000Z",
      endsAt: null,
    };
    order = {
      orderId: "102",
      status: "paid",
      total: 3000,
      refundedAmount: 0,
      updatedAt: subscription.updatedAt,
    };
    const newer = await record(
      webhook("new-access", subscription.updatedAt, NEWER_CORRELATION, {
        subscriptionId: subscription.subscriptionId,
        orderId: order.orderId,
      }),
    );
    expect(await reconcile(newer.receiptId)).toBe("applied");

    await expect(
      reconcileNextFounderCommerce({
        now: new Date("2026-08-23T01:02:00.000Z"),
        applicationRevision: "a".repeat(40),
        commerceProvider: provider,
        retirementProvider,
        createConnection: () => connection,
      }),
    ).resolves.toEqual({ processed: 1, outcome: "retirement_superseded" });
    expect((await connection.db.select().from(founderProductEntitlements))[0]).toMatchObject({
      providerSubscriptionId: "790",
      status: "verified",
    });
    expect(
      (await connection.db.select().from(founderCheckoutCorrelations)).find(
        (attempt) => attempt.generation === 1,
      ),
    ).toMatchObject({ closureReason: "payment_without_access_refunded_superseded" });
  });

  async function record(webhookInput: VerifiedLemonSqueezyWebhook) {
    return recordFounderCommerceWebhook({
      webhook: webhookInput,
      recordedAt: new Date(webhookInput.occurredAt),
      createConnection: () => connection,
    });
  }

  async function reconcile(receiptId: string) {
    return reconcileFounderCommerceReceipt({
      receiptId,
      now: new Date(subscription.updatedAt),
      provider,
      createConnection: () => connection,
    });
  }
});

function webhook(
  identity: string,
  occurredAt: string,
  checkoutCorrelation: string | null = CORRELATION,
  providerIdentity: { subscriptionId: string; orderId: string } = {
    subscriptionId: SUBSCRIPTION_ID,
    orderId: ORDER_ID,
  },
): VerifiedLemonSqueezyWebhook {
  const payloadDigest = digest(`${identity}:${occurredAt}`);
  return {
    derivedDeliveryKey: `lemon-squeezy:${payloadDigest}`,
    payloadDigest,
    eventName: "subscription_updated",
    resourceType: "subscriptions",
    resourceId: providerIdentity.subscriptionId,
    checkoutCorrelation,
    subscriptionId: providerIdentity.subscriptionId,
    orderId: providerIdentity.orderId,
    occurredAt,
  };
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function loopbackDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for concurrency coverage.");
  const parsed = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("Concurrency coverage requires loopback PostgreSQL.");
  }
  return parsed.toString();
}

async function waitForBlockedDatabaseSessions(
  observer: ReturnType<typeof postgres>,
  minimum: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await observer<{ blockedCount: number }[]>`
      select count(*)::int as "blockedCount"
      from pg_stat_activity
      where datname = current_database()
        and cardinality(pg_blocking_pids(pid)) > 0
    `;
    if ((row?.blockedCount ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${minimum} blocked database sessions.`);
}

function signedPortalUrl(now: Date): string {
  const expires = Math.floor((now.valueOf() + 24 * 60 * 60 * 1_000) / 1_000);
  return `https://bruno.lemonsqueezy.com/billing?expires=${expires}&user=380&signature=${"a".repeat(64)}`;
}

function unavailableRetirementProvider(): FounderInfrastructureRetirementProvider {
  return {
    createRecoveryArchive: vi.fn(),
    deleteRecoveryArchive: vi.fn(),
    digitalOcean: {
      observeOwnedSet: vi.fn(),
      deleteFirewall: vi.fn(),
      deleteDroplet: vi.fn(),
    },
    calls: () => [],
  } as unknown as FounderInfrastructureRetirementProvider;
}
