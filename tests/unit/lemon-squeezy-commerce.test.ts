import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  LemonSqueezyApiProvider,
  readLemonSqueezyConfig,
} from "@/src/server/commerce/lemon-squeezy-provider";
import {
  LemonSqueezyWebhookRequestError,
  parseVerifiedLemonSqueezyWebhook,
  readBoundedLemonSqueezyWebhookBody,
} from "@/src/server/commerce/lemon-squeezy-webhook";

const SECRET = "founder-commerce-test-webhook-secret";
const CONFIG = {
  mode: "test" as const,
  apiKey: "founder-commerce-test-api-key",
  webhookSecret: SECRET,
  storeId: "123",
  variantId: "456",
};

describe("Lemon Squeezy commerce boundary", () => {
  it("verifies the exact raw body before parsing and normalizes provider timestamps", () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        meta: {
          event_name: "subscription_created",
          test_mode: true,
          custom_data: { checkout_correlation: "a".repeat(43) },
        },
        data: {
          type: "subscriptions",
          id: "789",
          attributes: {
            order_id: 101,
            updated_at: "2026-08-23T01:02:03.000000Z",
          },
        },
      }),
    );
    const signature = createHmac("sha256", SECRET).update(rawBody).digest("hex");

    expect(
      parseVerifiedLemonSqueezyWebhook({
        rawBody,
        signature,
        headerEventName: "subscription_created",
        webhookSecret: SECRET,
        expectedMode: "test",
      }),
    ).toMatchObject({
      eventName: "subscription_created",
      subscriptionId: "789",
      orderId: "101",
      checkoutCorrelation: "a".repeat(43),
      occurredAt: "2026-08-23T01:02:03.000Z",
      payloadDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      derivedDeliveryKey: expect.stringMatching(/^lemon-squeezy:sha256:[a-f0-9]{64}$/),
    });

    expect(() =>
      parseVerifiedLemonSqueezyWebhook({
        rawBody: Buffer.from("not-json"),
        signature: "0".repeat(64),
        headerEventName: "subscription_created",
        webhookSecret: SECRET,
        expectedMode: "test",
      }),
    ).toThrowError(expect.objectContaining({ code: "webhook_signature_invalid" }));
  });

  it("rejects header/payload mismatch, wrong mode, and oversized bodies", async () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        meta: { event_name: "subscription_created", test_mode: true, custom_data: {} },
        data: {
          type: "subscriptions",
          id: "789",
          attributes: {
            order_id: 101,
            updated_at: "2026-08-23T01:02:03Z",
          },
        },
      }),
    );
    const signature = createHmac("sha256", SECRET).update(rawBody).digest("hex");
    expect(() =>
      parseVerifiedLemonSqueezyWebhook({
        rawBody,
        signature,
        headerEventName: "subscription_updated",
        webhookSecret: SECRET,
        expectedMode: "test",
      }),
    ).toThrowError(expect.objectContaining({ code: "webhook_event_invalid" }));
    expect(() =>
      parseVerifiedLemonSqueezyWebhook({
        rawBody,
        signature,
        headerEventName: "subscription_created",
        webhookSecret: SECRET,
        expectedMode: "live",
      }),
    ).toThrowError(expect.objectContaining({ code: "webhook_mode_mismatch" }));

    await expect(
      readBoundedLemonSqueezyWebhookBody(
        new Request("https://example.test", {
          method: "POST",
          headers: { "content-length": "257" },
          body: "x",
        }),
        256,
      ),
    ).rejects.toBeInstanceOf(LemonSqueezyWebhookRequestError);
  });

  it("creates an opaque-only checkout and validates reconciled provider identity", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(JSON.stringify(body)).toContain('"checkout_correlation":"a');
      expect(JSON.stringify(body)).not.toMatch(/clerk|email|user_id/i);
      return Response.json({
        data: {
          type: "checkouts",
          id: "999",
          attributes: {
            url: "https://bruno.lemonsqueezy.com/checkout/buy/test",
            test_mode: true,
            expires_at: "2026-08-23T02:00:00.000000Z",
            checkout_data: { custom: { checkout_correlation: "a".repeat(43) } },
          },
          relationships: {
            store: { data: { type: "stores", id: "123" } },
            variant: { data: { type: "variants", id: "456" } },
          },
        },
      });
    });
    const provider = new LemonSqueezyApiProvider({ config: CONFIG, fetch: fetchMock });

    await expect(
      provider.createCheckout({
        checkoutCorrelation: "a".repeat(43),
        redirectUrl: "http://localhost:3000/operator/payment",
        expiresAt: "2026-08-23T02:00:00.000Z",
      }),
    ).resolves.toEqual({
      checkoutId: "999",
      checkoutUrl: "https://bruno.lemonsqueezy.com/checkout/buy/test",
    });
  });

  it("is default-off and fails closed on partial provider configuration", () => {
    expect(readLemonSqueezyConfig({})).toBeNull();
    expect(() => readLemonSqueezyConfig({ BRUNO_LEMON_SQUEEZY_MODE: "live" })).toThrow(
      "API key is not configured safely",
    );
  });
});
