import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isOpaqueCheckoutCorrelation } from "./lemon-squeezy-provider";

export const LEMON_SQUEEZY_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

const ACCEPTED_EVENTS = new Set([
  "order_created",
  "order_refunded",
  "subscription_created",
  "subscription_updated",
  "subscription_payment_success",
  "subscription_payment_failed",
  "subscription_payment_refunded",
]);

export type VerifiedLemonSqueezyWebhook = {
  derivedDeliveryKey: string;
  payloadDigest: string;
  eventName: string;
  resourceType: "orders" | "subscriptions" | "subscription-invoices";
  resourceId: string;
  checkoutCorrelation: string | null;
  subscriptionId: string;
  orderId: string;
  occurredAt: string;
};

export async function readBoundedLemonSqueezyWebhookBody(
  request: Request,
  maxBytes = LEMON_SQUEEZY_WEBHOOK_MAX_BODY_BYTES,
): Promise<Buffer> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
      throw new LemonSqueezyWebhookRequestError("webhook_body_too_large");
    }
  }
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new LemonSqueezyWebhookRequestError("webhook_body_too_large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    length,
  );
}

export function parseVerifiedLemonSqueezyWebhook(input: {
  rawBody: Uint8Array;
  signature: string | null;
  headerEventName: string | null;
  webhookSecret: string;
  expectedMode: "test" | "live";
}): VerifiedLemonSqueezyWebhook {
  verifySignature(input.rawBody, input.signature, input.webhookSecret);

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.rawBody));
  } catch {
    throw new LemonSqueezyWebhookRequestError("webhook_payload_invalid");
  }
  const root = requireRecord(payload);
  const meta = requireRecord(root.meta);
  const eventName = requireString(meta.event_name);
  if (
    !ACCEPTED_EVENTS.has(eventName) ||
    !input.headerEventName ||
    input.headerEventName !== eventName
  ) {
    throw new LemonSqueezyWebhookRequestError("webhook_event_invalid");
  }
  if (meta.test_mode !== (input.expectedMode === "test")) {
    throw new LemonSqueezyWebhookRequestError("webhook_mode_mismatch");
  }
  const data = requireRecord(root.data);
  const resourceType = requireResourceType(data.type);
  requireEventResourcePair(eventName, resourceType);
  const resourceId = requireProviderId(data.id);
  const attributes = requireRecord(data.attributes);
  const customData = optionalRecord(meta.custom_data);
  const checkoutCorrelation = optionalString(customData.checkout_correlation);
  if (checkoutCorrelation !== null && !isOpaqueCheckoutCorrelation(checkoutCorrelation)) {
    throw new LemonSqueezyWebhookRequestError("webhook_correlation_invalid");
  }
  const firstOrderItem = optionalRecord(attributes.first_order_item);
  const subscriptionId = firstProviderId(
    resourceType === "subscriptions" ? resourceId : null,
    attributes.subscription_id,
    firstOrderItem.subscription_id,
  );
  const orderId = firstProviderId(
    resourceType === "orders" ? resourceId : null,
    attributes.order_id,
  );
  if (!subscriptionId || !orderId) {
    throw new LemonSqueezyWebhookRequestError("webhook_commerce_identity_missing");
  }
  const occurredAt = normalizeProviderInstant(attributes.updated_at ?? attributes.created_at);
  const payloadDigest = `sha256:${createHash("sha256").update(input.rawBody).digest("hex")}`;
  return {
    derivedDeliveryKey: `lemon-squeezy:${payloadDigest}`,
    payloadDigest,
    eventName,
    resourceType,
    resourceId,
    checkoutCorrelation,
    subscriptionId,
    orderId,
    occurredAt,
  };
}

export class LemonSqueezyWebhookRequestError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Lemon Squeezy webhook request was rejected.");
    this.name = "LemonSqueezyWebhookRequestError";
    this.code = code;
  }
}

function verifySignature(
  rawBody: Uint8Array,
  signature: string | null,
  webhookSecret: string,
): void {
  if (!webhookSecret || !signature || !/^[a-f0-9]{64}$/i.test(signature)) {
    throw new LemonSqueezyWebhookRequestError("webhook_signature_invalid");
  }
  const expected = createHmac("sha256", webhookSecret).update(rawBody).digest();
  const actual = Buffer.from(signature.toLowerCase(), "hex");
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(expected, actual)) {
    throw new LemonSqueezyWebhookRequestError("webhook_signature_invalid");
  }
}

function requireEventResourcePair(eventName: string, resourceType: string): void {
  const valid =
    (eventName.startsWith("order_") && resourceType === "orders") ||
    (eventName.startsWith("subscription_payment_") && resourceType === "subscription-invoices") ||
    ((eventName === "subscription_created" || eventName === "subscription_updated") &&
      resourceType === "subscriptions");
  if (!valid) throw new LemonSqueezyWebhookRequestError("webhook_event_resource_mismatch");
}

function requireResourceType(value: unknown): VerifiedLemonSqueezyWebhook["resourceType"] {
  if (value === "orders" || value === "subscriptions" || value === "subscription-invoices") {
    return value;
  }
  throw new LemonSqueezyWebhookRequestError("webhook_resource_invalid");
}

function firstProviderId(...values: unknown[]): string | null {
  for (const value of values) {
    const id = optionalProviderId(value);
    if (id) return id;
  }
  return null;
}

function requireProviderId(value: unknown): string {
  const id = optionalProviderId(value);
  if (!id) throw new LemonSqueezyWebhookRequestError("webhook_resource_identity_invalid");
  return id;
}

function optionalProviderId(value: unknown): string | null {
  const normalized = typeof value === "number" ? String(value) : value;
  return typeof normalized === "string" && /^[1-9][0-9]{0,19}$/.test(normalized)
    ? normalized
    : null;
}

function normalizeProviderInstant(value: unknown): string {
  if (typeof value !== "string") {
    throw new LemonSqueezyWebhookRequestError("webhook_timestamp_invalid");
  }
  const instant = new Date(value);
  if (Number.isNaN(instant.valueOf())) {
    throw new LemonSqueezyWebhookRequestError("webhook_timestamp_invalid");
  }
  return instant.toISOString();
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LemonSqueezyWebhookRequestError("webhook_payload_invalid");
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LemonSqueezyWebhookRequestError("webhook_payload_invalid");
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
