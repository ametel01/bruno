import { createHash } from "node:crypto";
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
  operators,
  users,
} from "@/src/server/db/schema";
import type { FounderInfrastructureRetirementProvider } from "@/src/server/founder-product-contract/infrastructure-retirement";

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
