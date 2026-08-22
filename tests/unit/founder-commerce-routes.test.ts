import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { POST as startCheckout } from "@/app/api/operator/commerce/checkout/route";
import { GET as readStatus } from "@/app/api/operator/commerce/status/route";
import { POST as receiveWebhook } from "@/app/api/webhooks/lemon-squeezy/route";
import type { LemonSqueezyCommerceProvider } from "@/src/server/commerce/lemon-squeezy-provider";

const USER_ID = "00000000-0000-4000-8000-000000000380";

describe("Founder commerce routes", () => {
  it("requires Bruno's authenticated internal Owner and does not grant on checkout", async () => {
    const createCheckout = vi.fn(async () => ({
      checkoutUrl: "https://checkout.lemonsqueezy.com/x",
    }));
    const provider = {} as LemonSqueezyCommerceProvider;
    const response = await startCheckout(
      new Request("https://bruno.example/api/operator/commerce/checkout", { method: "POST" }),
      undefined,
      {
        requireUser: async () => ({ ok: true, userId: USER_ID }),
        createProvider: () => provider,
        createCheckout,
        appUrl: () => "https://bruno.example",
        now: () => new Date("2026-08-23T00:00:00.000Z"),
      },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://checkout.lemonsqueezy.com/x");
    expect(createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, provider }),
    );

    const unauthorized = await startCheckout(
      new Request("https://bruno.example/api/operator/commerce/checkout", { method: "POST" }),
      undefined,
      { requireUser: async () => ({ ok: false, status: 401, code: "unauthenticated" }) },
    );
    expect(unauthorized.status).toBe(401);
  });

  it("projects persisted status without accepting browser correlation data", async () => {
    const getStatus = vi.fn(async () => ({
      state: "entitled" as const,
      status: "verified" as const,
      retirementDueAt: null,
    }));
    const response = await readStatus(
      new Request("https://bruno.example/api/operator/commerce/status"),
      undefined,
      { requireUser: async () => ({ ok: true, userId: USER_ID }), getStatus },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ commerce: { state: "entitled" } });
    expect(getStatus).toHaveBeenCalledWith(USER_ID);

    const queryAttempt = await readStatus(
      new Request("https://bruno.example/api/operator/commerce/status?success=true"),
      undefined,
      { requireUser: async () => ({ ok: true, userId: USER_ID }), getStatus },
    );
    expect(queryAttempt.status).toBe(400);
  });

  it("rejects an invalid signature before recording and accepts a verified delivery", async () => {
    const secret = "founder-commerce-route-secret";
    const rawBody = JSON.stringify({
      meta: {
        event_name: "subscription_created",
        test_mode: true,
        custom_data: { checkout_correlation: "a".repeat(43) },
      },
      data: {
        type: "subscriptions",
        id: "789",
        attributes: { order_id: 101, updated_at: "2026-08-23T00:00:00.000000Z" },
      },
    });
    const provider = {} as LemonSqueezyCommerceProvider;
    const record = vi.fn(async () => ({
      receiptId: "00000000-0000-4000-8000-000000000381",
      userId: USER_ID,
      terminal: false,
      duplicate: false,
    }));
    const reconcile = vi.fn(async () => "applied" as const);
    const boundary = () => ({ provider, webhookSecret: secret, mode: "test" as const });

    const invalid = await receiveWebhook(webhookRequest(rawBody, "0".repeat(64)), undefined, {
      createProvider: boundary,
      record,
      reconcile,
    });
    expect(invalid.status).toBe(401);
    expect(record).not.toHaveBeenCalled();

    const signature = createHmac("sha256", secret).update(rawBody).digest("hex");
    const valid = await receiveWebhook(webhookRequest(rawBody, signature), undefined, {
      createProvider: boundary,
      record,
      reconcile,
      now: () => new Date("2026-08-23T00:00:01.000Z"),
    });
    expect(valid.status).toBe(202);
    expect(record).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ receiptId: "00000000-0000-4000-8000-000000000381" }),
    );
  });
});

function webhookRequest(body: string, signature: string): Request {
  return new Request("https://bruno.example/api/webhooks/lemon-squeezy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-event-name": "subscription_created",
      "x-signature": signature,
    },
    body,
  });
}
