import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderCheckoutCorrelations,
  founderCommerceEvents,
  founderProductEntitlements,
  operators,
  users,
} from "@/src/server/db/schema";
import {
  createFounderCheckout,
  recordFounderCommerceWebhook,
  reconcileFounderCommerceReceipt,
} from "@/src/server/commerce/founder-commerce";
import { reconcileNextFounderCommerce } from "@/src/server/commerce/founder-commerce-reconciler";
import type {
  LemonSqueezyCommerceProvider,
  ReconciledLemonSqueezyOrder,
  ReconciledLemonSqueezySubscription,
} from "@/src/server/commerce/lemon-squeezy-provider";
import type { VerifiedLemonSqueezyWebhook } from "@/src/server/commerce/lemon-squeezy-webhook";
import type { FounderInfrastructureRetirementProvider } from "@/src/server/founder-product-contract/infrastructure-retirement";

const USER_ID = "00000000-0000-4000-8000-000000000380";
const CORRELATION = "a".repeat(43);
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
    });
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
): VerifiedLemonSqueezyWebhook {
  const payloadDigest = digest(`${identity}:${occurredAt}`);
  return {
    derivedDeliveryKey: `lemon-squeezy:${payloadDigest}`,
    payloadDigest,
    eventName: "subscription_updated",
    resourceType: "subscriptions",
    resourceId: SUBSCRIPTION_ID,
    checkoutCorrelation,
    subscriptionId: SUBSCRIPTION_ID,
    orderId: ORDER_ID,
    occurredAt,
  };
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
