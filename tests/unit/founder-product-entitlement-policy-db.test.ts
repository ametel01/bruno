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
  });

  async function reconcile(commerceEvent: FounderCommerceEvent): Promise<void> {
    await connection.db.transaction((tx) =>
      reconcileFounderCommerceEvent(
        tx,
        { userId: USER_ID, now: new Date(commerceEvent.occurredAt), commerceEvent },
        {
          commerceWebhookSecret: SECRET,
          providers: { readSubscription: async () => ({ status: providerStatus }) },
        },
      ),
    );
  }
});

function event(status: FounderCommerceStatus, occurredAt: string): FounderCommerceEvent {
  const payload = {
    eventId: `event-${status}`,
    checkoutCorrelation: CORRELATION,
    subscriptionId: SUBSCRIPTION_ID,
    status,
    endsAt: null,
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
