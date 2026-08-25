import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderCheckoutCorrelations,
  founderProductEntitlements,
  operators,
  users,
} from "@/src/server/db/schema";
import {
  reconcileFounderCommerceEvent,
  requireOperationalEntitlement,
} from "@/src/server/founder-product-contract/entitlement";
import {
  assertFounderExternalActionsNotPaused,
  assertFounderExternalActionsNotPausedInTransaction,
} from "@/src/server/operators/founder-ai-work";
import type {
  FounderCommerceEvent,
  FounderCommerceStatus,
} from "@/src/server/founder-product-contract/lifecycle";

const USER_ID = "00000000-0000-4000-8000-000000003722";
const SECRET = "entitlement-policy-test-secret";
const CORRELATION = "owner-bound-checkout-correlation";
const SUBSCRIPTION_ID = "subscription-372";

describe("persisted Founder Product Entitlement policy", () => {
  let connection: DatabaseConnection;
  let providerStatus: FounderCommerceStatus;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await connection.client.unsafe("truncate table users restart identity cascade");
    await connection.db.insert(users).values({ id: USER_ID });
    await connection.db.insert(operators).values({ userId: USER_ID });
    await connection.db.insert(founderCheckoutCorrelations).values({
      userId: USER_ID,
      correlationDigest: digest(CORRELATION),
      status: "pending",
      createdAt: new Date("2026-08-21T08:00:00.000Z"),
      expiresAt: new Date("2026-08-21T10:00:00.000Z"),
    });
    providerStatus = "active";
  });

  afterEach(async () => {
    await connection.client.unsafe("truncate table users restart identity cascade");
    await connection.close();
  });

  it("persists the provider identity on a consumed contract Checkout Correlation", async () => {
    const occurredAt = "2026-08-21T08:01:00.000Z";
    await reconcile(event("active", occurredAt));

    const [correlation] = await connection.db.select().from(founderCheckoutCorrelations);
    expect(correlation).toMatchObject({
      status: "consumed",
      providerSubscriptionId: SUBSCRIPTION_ID,
      providerOrderId: `order-${SUBSCRIPTION_ID}`,
      consumedAt: new Date(occurredAt),
      paymentDetectedAt: new Date(occurredAt),
      reconciliationDueAt: new Date("2026-08-21T09:01:00.000Z"),
    });
  });

  it("accepts a delayed signed payment that occurred before the Checkout Correlation expired", async () => {
    const occurredAt = "2026-08-21T09:59:59.999Z";
    const processedAt = new Date("2026-08-21T10:05:00.000Z");

    await reconcile(event("active", occurredAt), processedAt);

    const [correlation] = await connection.db.select().from(founderCheckoutCorrelations);
    expect(correlation).toMatchObject({
      status: "consumed",
      consumedAt: processedAt,
      paymentDetectedAt: new Date(occurredAt),
    });
  });

  it("rejects a signed payment whose occurrence was after the Checkout Correlation expired", async () => {
    const occurredAt = "2026-08-21T10:00:00.001Z";

    await expect(
      reconcile(event("active", occurredAt), new Date("2026-08-21T09:59:00.000Z")),
    ).rejects.toThrow("A pending Owner-bound Checkout Correlation is required.");

    const [correlation] = await connection.db.select().from(founderCheckoutCorrelations);
    expect(correlation).toMatchObject({ status: "pending" });
  });

  it.each([
    "unpaid",
    "refunded",
  ] as const)("immediately pauses new work when entitlement becomes %s", async (status) => {
    await reconcile(event("active", "2026-08-21T08:01:00.000Z"));
    providerStatus = status;
    await reconcile(event(status, "2026-08-21T08:02:00.000Z"));

    const [operator] = await connection.db.select().from(operators);
    const [entitlement] = await connection.db.select().from(founderProductEntitlements);
    expect(operator).toMatchObject({
      externalActionPause: true,
      externalActionPauseReason: "Product Entitlement does not authorize new work.",
    });
    expect(entitlement).toMatchObject({
      status,
      retirementDueAt: new Date("2026-08-22T08:02:00.000Z"),
    });
  });

  it("retains operation only inside the bounded past_due recovery window", async () => {
    await reconcile(event("active", "2026-08-21T08:01:00.000Z"));
    providerStatus = "past_due";
    await reconcile(event("past_due", "2026-08-21T08:02:00.000Z"));

    await expect(
      connection.db.transaction((tx) =>
        requireOperationalEntitlement(tx, USER_ID, new Date("2026-08-28T08:01:59.999Z")),
      ),
    ).resolves.toBeUndefined();
    await expect(
      connection.db.transaction((tx) =>
        requireOperationalEntitlement(tx, USER_ID, new Date("2026-08-28T08:02:00.000Z")),
      ),
    ).rejects.toThrow("Operational Product Entitlement is required");

    const [operator] = await connection.db.select().from(operators);
    expect(operator?.externalActionPause).toBe(false);
    await expect(
      assertFounderExternalActionsNotPaused(USER_ID, {
        createConnection: () => connection,
        now: () => new Date("2026-08-28T08:01:59.999Z"),
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertFounderExternalActionsNotPaused(USER_ID, {
        createConnection: () => connection,
        now: () => new Date("2026-08-28T08:02:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "external_action_paused", status: 409 });
    await expect(
      connection.db.transaction((tx) =>
        assertFounderExternalActionsNotPausedInTransaction(
          tx,
          operator?.id ?? "missing-operator",
          new Date("2026-08-28T08:02:00.000Z"),
        ),
      ),
    ).rejects.toMatchObject({ code: "external_action_paused", status: 409 });
  });

  it("stops external work at the paid cancellation boundary", async () => {
    await reconcile(event("active", "2026-08-21T08:01:00.000Z"));
    providerStatus = "cancelled";
    await reconcile(event("cancelled", "2026-08-21T08:02:00.000Z", "2026-09-01T00:00:00.000Z"));

    await expect(
      assertFounderExternalActionsNotPaused(USER_ID, {
        createConnection: () => connection,
        now: () => new Date("2026-08-31T23:59:59.999Z"),
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertFounderExternalActionsNotPaused(USER_ID, {
        createConnection: () => connection,
        now: () => new Date("2026-09-01T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "external_action_paused", status: 409 });
  });

  async function reconcile(
    commerceEvent: FounderCommerceEvent,
    processedAt = new Date(commerceEvent.occurredAt),
  ): Promise<void> {
    await connection.db.transaction((tx) =>
      reconcileFounderCommerceEvent(
        tx,
        { userId: USER_ID, now: processedAt, commerceEvent },
        {
          commerceWebhookSecret: SECRET,
          providers: { readSubscription: async () => ({ status: providerStatus }) },
        },
      ),
    );
  }
});

function event(
  status: FounderCommerceStatus,
  occurredAt: string,
  endsAt: string | null = null,
): FounderCommerceEvent {
  const payload = {
    eventId: `event-${status}`,
    checkoutCorrelation: CORRELATION,
    subscriptionId: SUBSCRIPTION_ID,
    status,
    endsAt,
    occurredAt,
  };
  return {
    ...payload,
    signature: `hmac-sha256:${createHmac("sha256", SECRET)
      .update(JSON.stringify(payload))
      .digest("hex")}`,
  };
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
